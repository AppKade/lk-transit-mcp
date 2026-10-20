import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { LMT } from '@lkt/core';
import type { Clock, Db } from '@lkt/core';
import { createPgliteDb, migrate } from '@lkt/db';
import {
  STALE_STAGED_MS,
  ensureProvider,
  listFeeds,
  pruneRetired,
  rollbackFeed,
  runStaticIngest,
} from '../../src/static/index.js';
import type { StaticIngestDeps, StaticIngestOptions } from '../../src/static/index.js';
import { editTable, fixtureBytes, fixtureWith } from '../../../gtfs/test/static/helpers.js';

const T0 = Date.parse('2026-10-20T10:15:30Z');

interface World {
  db: Db & { close(): Promise<void> };
  clock: Clock & { set(ms: number): void };
  /** What the fake upstream serves next. */
  serve: { bytes: Uint8Array | null; status: number };
  archived: Map<string, Uint8Array>;
  deps(db?: Db): StaticIngestDeps;
  ingest(o?: StaticIngestOptions, db?: Db): ReturnType<typeof runStaticIngest>;
}

// One in-memory Postgres for the file (start-up dominates); tables are reset before every test.
const shared = await createPgliteDb();
await migrate(shared);

async function world(): Promise<World> {
  const db = shared;
  await db.query('TRUNCATE providers, feed_versions RESTART IDENTITY CASCADE');
  let now = T0;
  const clock = { now: () => now, set: (ms: number) => void (now = ms) };
  const serve = { bytes: null as Uint8Array | null, status: 200 };
  const archived = new Map<string, Uint8Array>();
  const fetchImpl = (async () => new Response(serve.status === 200 ? serve.bytes : 'nope', { status: serve.status })) as typeof fetch;
  const deps = (d: Db = db): StaticIngestDeps => ({
    db: d,
    provider: LMT,
    clock,
    fetchImpl,
    archive: { put: async (k, b) => void archived.set(k, b) },
  });
  return { db, clock, serve, archived, deps, ingest: (o, d) => runStaticIngest(deps(d), o) };
}

const count = async (db: Db, table: string, fv: number) =>
  Number((await db.query<{ n: number | string }>(`SELECT count(*) AS n FROM ${table} WHERE feed_version_id = $1`, [fv])).rows[0]!.n);
const activeId = async (db: Db) =>
  (await db.query<{ a: number | string | null }>(`SELECT active_feed_version_id AS a FROM providers WHERE id = 'lmt'`)).rows[0]!.a;
const statuses = async (db: Db) =>
  (await db.query<{ id: number | string; status: string }>('SELECT id, status FROM feed_versions ORDER BY id')).rows.map((r) => `${Number(r.id)}:${r.status}`);

/** v1 = the real fixture; v2 = same feed with a renamed stop, so the checksum differs but the bands do not. */
const v2Bytes = () => fixtureWith((f) => editTable(f, 'stops.txt', (rows) => void (rows[0]!.stop_name = 'Renamed Stop')));
const expiredBytes = () => fixtureWith((f) => editTable(f, 'calendar.txt', (rows) => void (rows[0]!.end_date = '20261001')));

/** Wraps a Db so that statements matching `fail` throw (top-level and inside transactions). */
function failing(inner: Db, fail: RegExp): Db {
  const wrap = (d: Db): Db => ({
    query: (sql, params) => (fail.test(sql) ? Promise.reject(new Error('injected failure')) : d.query(sql, params)),
    transaction: (fn) => d.transaction((tx) => fn(wrap(tx))),
  });
  return wrap(inner);
}

afterAll(() => shared.close());

let w: World;
beforeEach(async () => {
  w = await world();
  w.serve.bytes = fixtureBytes();
});

describe('first ingest', () => {
  it('stages, loads and activates the real fixture', async () => {
    const r = await w.ingest();
    if (r.status !== 'activated') throw new Error(`unexpected ${JSON.stringify(r)}`);
    expect(r.previous_feed_version_id).toBeNull();
    expect(r.label).toMatch(/^2026-10-20T10:15Z-[0-9a-f]{6}$/);
    expect(r.label.slice(-6)).toBe(r.checksum.slice(0, 6));
    expect(r.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(r.report.acceptable).toBe(true);

    expect(Number(await activeId(w.db))).toBe(r.feed_version_id);
    const fv = r.feed_version_id;
    expect(await count(w.db, 'stops', fv)).toBe(220);
    expect(await count(w.db, 'routes', fv)).toBe(7);
    expect(await count(w.db, 'trips', fv)).toBe(56);
    expect(await count(w.db, 'stop_times', fv)).toBe(1092);
    expect(await count(w.db, 'calendars', fv)).toBe(1);
    expect(await count(w.db, 'shapes', fv)).toBe(12393);

    const [info] = await listFeeds(w.db, 'lmt');
    expect(info).toMatchObject({
      id: fv,
      status: 'active',
      is_active: true,
      label: r.label,
      calendar_start: '2026-01-01',
      calendar_end: '2027-12-31',
      fetched_at: '2026-10-20T10:15:30Z',
      activated_at: '2026-10-20T10:15:30Z',
      counts: { routes: 7, stops: 220, trips: 56, stop_times: 1092 },
      errors: 0,
      warnings: 1,
      source_key: 'lmt.gtfs',
    });
    const stored = await w.db.query<{ validation: { acceptable: boolean } }>('SELECT validation FROM feed_versions WHERE id = $1', [fv]);
    expect(stored.rows[0]!.validation.acceptable).toBe(true);
  });

  it('stores values faithfully (times, booleans, dates)', async () => {
    const r = await w.ingest();
    const fv = (r as { feed_version_id: number }).feed_version_id;
    const st = await w.db.query<{ arrival_sec: number; departure_sec: number; stop_id: string }>(
      `SELECT * FROM stop_times WHERE feed_version_id = $1 AND trip_id = 'TRIP_CM01_D0_T1' AND stop_sequence = 1`,
      [fv],
    );
    expect(st.rows[0]).toMatchObject({ stop_id: '1', arrival_sec: 23400, departure_sec: 23400 });
    const cal = await w.db.query<{ monday: boolean; sunday: boolean; s: string; e: string }>(
      `SELECT monday, sunday, start_date::text AS s, end_date::text AS e FROM calendars WHERE feed_version_id = $1`,
      [fv],
    );
    expect(cal.rows[0]).toEqual({ monday: true, sunday: true, s: '2026-01-01', e: '2027-12-31' });
    const stop = await w.db.query<{ name: string; lat: number; lon: number }>(`SELECT name, lat, lon FROM stops WHERE feed_version_id = $1 AND stop_id = '22'`, [fv]);
    expect(stop.rows[0]).toEqual({ name: 'Pettah', lat: 6.93444, lon: 79.85492 });
  });

  it('archives the raw zip under a label-derived key', async () => {
    const r = await w.ingest();
    if (r.status !== 'activated') throw new Error('expected activation');
    expect(r.archive_key).toBe(`lmt/gtfs/${r.label}.zip`);
    expect(Buffer.from(w.archived.get(r.archive_key!)!).equals(Buffer.from(fixtureBytes()))).toBe(true);
  });

  it('survives an archive outage', async () => {
    const deps = { ...w.deps(), archive: { put: async () => Promise.reject(new Error('r2 down')) } };
    const r = await runStaticIngest(deps);
    expect(r).toMatchObject({ status: 'activated', archive_key: null, archive_error: 'r2 down' });
  });

  it('ensureProvider is idempotent and updates metadata', async () => {
    await ensureProvider(w.db, LMT);
    await ensureProvider(w.db, { ...LMT, name: 'Renamed' });
    const rows = (await w.db.query<{ name: string }>(`SELECT name FROM providers`)).rows;
    expect(rows).toEqual([{ name: 'Renamed' }]);
  });
});

describe('repeat and changed feeds', () => {
  it('returns unchanged for an identical payload and writes nothing', async () => {
    const first = await w.ingest();
    const before = await statuses(w.db);
    w.clock.set(T0 + 3600_000);
    const second = await w.ingest();
    expect(second).toMatchObject({ status: 'unchanged', checksum: (first as { checksum: string }).checksum });
    expect(await statuses(w.db)).toEqual(before);
  });

  it('re-ingests identical bytes when forced, retiring the old version', async () => {
    const first = (await w.ingest()) as { feed_version_id: number };
    w.clock.set(T0 + 3600_000);
    const forced = await w.ingest({ force: true });
    if (forced.status !== 'activated') throw new Error(JSON.stringify(forced));
    expect(forced.previous_feed_version_id).toBe(first.feed_version_id);
    expect(await statuses(w.db)).toEqual(['1:retired', '2:active']);
    expect(await count(w.db, 'stop_times', forced.feed_version_id)).toBe(1092);
    // and the next unforced run still recognises the bytes as unchanged
    expect((await w.ingest()).status).toBe('unchanged');
  });

  it('swaps a changed feed in atomically and retires the previous one', async () => {
    const first = (await w.ingest()) as { feed_version_id: number };
    w.serve.bytes = v2Bytes();
    w.clock.set(T0 + 3600_000);

    // Record what runs inside transactions to prove the switch is a single atomic unit.
    const txSql: string[] = [];
    const spy: Db = {
      query: (s, p) => w.db.query(s, p),
      transaction: (fn) => w.db.transaction((tx) => fn({ query: (s, p) => (txSql.push(s), tx.query(s, p)), transaction: (f) => tx.transaction(f) })),
    };
    const r = await w.ingest({}, spy);
    if (r.status !== 'activated') throw new Error(JSON.stringify(r));
    expect(r.previous_feed_version_id).toBe(first.feed_version_id);
    expect(txSql.filter((s) => /^UPDATE/.test(s.trim())).length).toBe(3);
    expect(txSql.some((s) => /UPDATE providers SET active_feed_version_id/.test(s))).toBe(true);
    expect(txSql.some((s) => /status = 'retired'/.test(s))).toBe(true);

    expect(await statuses(w.db)).toEqual(['1:retired', '2:active']);
    expect(Number(await activeId(w.db))).toBe(r.feed_version_id);
    // both versions' rows coexist, tagged by version
    expect(await count(w.db, 'stops', first.feed_version_id)).toBe(220);
    expect(await count(w.db, 'stops', r.feed_version_id)).toBe(220);
    const name = (fv: number) => w.db.query<{ name: string }>(`SELECT name FROM stops WHERE feed_version_id = $1 ORDER BY stop_id LIMIT 1 OFFSET 0`, [fv]);
    expect((await name(first.feed_version_id)).rows[0]!.name).not.toBe('Renamed Stop');
  });

  it('activates but flags needs_review when counts swing past the band', async () => {
    await w.ingest();
    const keepRoutes = new Set(['c0040000-0000-4000-8000-000000000004', 'c0080000-0000-4000-8000-000000000008']);
    let dropped = new Set<string>();
    w.serve.bytes = fixtureWith(
      (f) =>
        editTable(f, 'trips.txt', (rows) => {
          const keep = rows.filter((t) => keepRoutes.has(t.route_id));
          dropped = new Set(rows.filter((t) => !keepRoutes.has(t.route_id)).map((t) => t.trip_id));
          return keep;
        }),
      (f) => editTable(f, 'stop_times.txt', (rows) => rows.filter((s) => !dropped.has(s.trip_id))),
    );
    const r = await w.ingest();
    if (r.status !== 'activated') throw new Error(JSON.stringify(r));
    expect(r.report.needs_review).toBe(true);
    expect(r.report.issues.map((i) => i.rule)).toContain('counts.band_exceeded');
    expect((await listFeeds(w.db, 'lmt'))[0]).toMatchObject({ needs_review: true, status: 'active' });
  });
});

describe('bad feeds never displace the active one', () => {
  const stopsServed = async (fv: number) => count(w.db, 'stops', fv);

  it('rejects a feed with no usable service and keeps serving the old one', async () => {
    const first = (await w.ingest()) as { feed_version_id: number };
    w.serve.bytes = expiredBytes();
    const r = await w.ingest();
    if (r.status !== 'rejected') throw new Error(JSON.stringify(r));
    expect(r.report.issues.map((i) => i.rule)).toContain('calendar.no_future_service');
    expect(await statuses(w.db)).toEqual(['1:active', '2:rejected']);
    expect(Number(await activeId(w.db))).toBe(first.feed_version_id);
    expect(await stopsServed(first.feed_version_id)).toBe(220);
    expect(await stopsServed(r.feed_version_id)).toBe(0);
    const [rejected] = await listFeeds(w.db, 'lmt');
    expect(rejected).toMatchObject({ status: 'rejected', is_active: false, errors: 1 });
  });

  it('does not record the same rejected payload twice', async () => {
    await w.ingest();
    w.serve.bytes = expiredBytes();
    const a = await w.ingest();
    const b = await w.ingest();
    expect(b).toMatchObject({ status: 'rejected', repeat: true, feed_version_id: (a as { feed_version_id: number }).feed_version_id });
    expect(await statuses(w.db)).toEqual(['1:active', '2:rejected']);
    // force re-evaluates it
    expect(await w.ingest({ force: true })).toMatchObject({ status: 'rejected' });
    expect(await statuses(w.db)).toEqual(['1:active', '2:rejected', '3:rejected']);
  });

  it('rejects garbage bytes, truncated zips and corrupt content', async () => {
    const first = (await w.ingest()) as { feed_version_id: number };
    const good = fixtureBytes();
    const dangling = fixtureWith((f) => editTable(f, 'trips.txt', (rows) => rows.forEach((t) => (t.route_id = 'ghost'))));
    const cases: [Uint8Array, string][] = [
      [new Uint8Array(4096).map((_, i) => (i * 17) & 0xff), 'zip.invalid'],
      [good.slice(0, good.length >> 1), 'zip.invalid'],
      [new TextEncoder().encode('<html>503 Service Unavailable</html>'), 'zip.invalid'],
      [dangling, 'rows.drop_threshold_exceeded'],
    ];
    for (const [bytes, rule] of cases) {
      w.serve.bytes = bytes;
      const r = await w.ingest();
      if (r.status !== 'rejected') throw new Error(`${rule}: ${JSON.stringify(r)}`);
      expect(r.report.issues.map((i) => i.rule)).toContain(rule);
      expect(Number(await activeId(w.db))).toBe(first.feed_version_id);
    }
    expect(await stopsServed(first.feed_version_id)).toBe(220);
    expect((await statuses(w.db)).filter((s) => s.endsWith('rejected'))).toHaveLength(4);
  });

  it('rejects a first-ever bad feed and leaves the provider without an active version', async () => {
    w.serve.bytes = expiredBytes();
    expect((await w.ingest()).status).toBe('rejected');
    expect(await activeId(w.db)).toBeNull();
  });

  it('reports upstream failures without touching the database', async () => {
    const first = (await w.ingest()) as { feed_version_id: number };
    w.serve.status = 503;
    expect(await w.ingest()).toMatchObject({ status: 'failed', stage: 'fetch', error: expect.stringContaining('503') });
    const boom = { ...w.deps(), fetchImpl: (async () => Promise.reject(new Error('ECONNRESET'))) as typeof fetch };
    expect(await runStaticIngest(boom)).toMatchObject({ status: 'failed', stage: 'fetch', error: 'ECONNRESET' });
    expect(await statuses(w.db)).toEqual(['1:active']);
    expect(Number(await activeId(w.db))).toBe(first.feed_version_id);
  });

  it('enforces the size cap and the timeout', async () => {
    expect(await w.ingest({ maxDownloadBytes: 1000 })).toMatchObject({ status: 'failed', stage: 'fetch', error: expect.stringContaining('exceeds') });
    const hang = {
      ...w.deps(),
      fetchImpl: ((_u: unknown, init?: RequestInit) =>
        new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as typeof fetch,
    };
    expect(await runStaticIngest(hang, { fetchTimeoutMs: 30 })).toMatchObject({ status: 'failed', stage: 'fetch', error: expect.stringContaining('timed out') });
    expect(await activeId(w.db)).toBeNull();
  });

  it('keeps the old version active when the load fails midway, and cleans up', async () => {
    const first = (await w.ingest()) as { feed_version_id: number };
    w.serve.bytes = v2Bytes();
    const r = await w.ingest({}, failing(w.db, /INSERT INTO stop_times/));
    expect(r).toMatchObject({ status: 'failed', stage: 'load', error: 'injected failure' });
    expect(await statuses(w.db)).toEqual(['1:active']);
    expect(Number(await activeId(w.db))).toBe(first.feed_version_id);
    expect(await stopsServed(first.feed_version_id)).toBe(220);
    expect(await count(w.db, 'stops', 2)).toBe(0); // partial rows removed with the version
    // the next run simply succeeds
    expect((await w.ingest()).status).toBe('activated');
  });

  it('leaves no visible half-feed when even the cleanup fails, and sweeps it on the next run', async () => {
    const first = (await w.ingest()) as { feed_version_id: number };
    w.serve.bytes = v2Bytes();
    const r = await w.ingest({}, failing(w.db, /INSERT INTO stop_times|DELETE FROM feed_versions WHERE id/));
    expect(r).toMatchObject({ status: 'failed', stage: 'load' });
    expect(await statuses(w.db)).toEqual(['1:active', '2:staged']);
    expect(await count(w.db, 'stops', 2)).toBe(220); // orphaned rows exist but are not served
    expect(Number(await activeId(w.db))).toBe(first.feed_version_id);

    // a fresh run shortly afterwards leaves it alone (it might belong to a live run)...
    w.serve.bytes = fixtureBytes();
    w.clock.set(T0 + 60_000);
    await w.ingest();
    expect(await statuses(w.db)).toEqual(['1:active', '2:staged']);
    // ...but once it is stale it is removed together with its rows
    w.clock.set(T0 + STALE_STAGED_MS + 60_000);
    await w.ingest();
    expect(await statuses(w.db)).toEqual(['1:active']);
    expect(await count(w.db, 'stops', 2)).toBe(0);
    expect(await stopsServed(first.feed_version_id)).toBe(220);
  });

  it('leaves the old version active when the activation transaction fails', async () => {
    const first = (await w.ingest()) as { feed_version_id: number };
    w.serve.bytes = v2Bytes();
    const r = await w.ingest({}, failing(w.db, /UPDATE providers SET active_feed_version_id/));
    expect(r).toMatchObject({ status: 'failed', stage: 'activate' });
    // the transaction rolled back: old version still active, not retired
    expect(await statuses(w.db)).toEqual(['1:active']);
    expect(Number(await activeId(w.db))).toBe(first.feed_version_id);
  });
});

describe('rollback, listing and pruning', () => {
  async function threeVersions() {
    await w.ingest();
    for (const name of ['B', 'C']) {
      w.serve.bytes = fixtureWith((f) => editTable(f, 'stops.txt', (rows) => void (rows[0]!.stop_name = `Stop ${name}`)));
      w.clock.set(w.clock.now() + 3600_000);
      expect((await w.ingest()).status).toBe('activated');
    }
  }

  it('rollbackFeed re-activates the most recent retired version', async () => {
    await w.ingest();
    w.serve.bytes = v2Bytes();
    w.clock.set(T0 + 3600_000);
    await w.ingest();
    expect(await statuses(w.db)).toEqual(['1:retired', '2:active']);

    const rb = await rollbackFeed(w.db, 'lmt', { now: T0 + 7200_000 });
    expect(rb).toMatchObject({ status: 'rolled_back', from_feed_version_id: 2, to_feed_version_id: 1 });
    expect(await statuses(w.db)).toEqual(['1:active', '2:retired']);
    expect(Number(await activeId(w.db))).toBe(1);
    const rows = await w.db.query<{ name: string }>(`SELECT name FROM stops WHERE feed_version_id = 1 AND stop_id = '22'`);
    expect(rows.rows[0]!.name).toBe('Pettah');
    // listFeeds reflects it, newest first
    expect((await listFeeds(w.db, 'lmt')).map((f) => [f.id, f.status, f.is_active])).toEqual([
      [2, 'retired', false],
      [1, 'active', true],
    ]);
  });

  it('rollbackFeed can target a specific retired version and reports when there is nothing to roll back to', async () => {
    expect(await rollbackFeed(w.db, 'lmt')).toEqual({ status: 'nothing_to_roll_back_to' });
    await threeVersions();
    expect(await statuses(w.db)).toEqual(['1:retired', '2:retired', '3:active']);
    expect(await rollbackFeed(w.db, 'lmt', { toFeedVersionId: 1 })).toMatchObject({ status: 'rolled_back', to_feed_version_id: 1 });
    expect(await statuses(w.db)).toEqual(['1:active', '2:retired', '3:retired']);
    expect(await rollbackFeed(w.db, 'lmt', { toFeedVersionId: 99 })).toEqual({ status: 'nothing_to_roll_back_to' });
  });

  it('pruneRetired deletes the oldest retired versions and their rows', async () => {
    await threeVersions();
    expect(await pruneRetired(w.db, 'lmt', 5)).toEqual([]);
    expect(await pruneRetired(w.db, 'lmt', 1)).toEqual([1]);
    expect(await statuses(w.db)).toEqual(['2:retired', '3:active']);
    for (const t of ['stops', 'stop_times', 'trips', 'shapes', 'calendars']) expect(await count(w.db, t, 1)).toBe(0);
    expect(await count(w.db, 'stops', 3)).toBe(220);
    expect(await pruneRetired(w.db, 'lmt', 0)).toEqual([2]);
    expect(await statuses(w.db)).toEqual(['3:active']);
  });

  it('a feed that reverts to an older retired payload is re-ingested as a new version', async () => {
    await w.ingest();
    w.serve.bytes = v2Bytes();
    w.clock.set(T0 + 3600_000);
    await w.ingest();
    w.serve.bytes = fixtureBytes();
    w.clock.set(T0 + 7200_000);
    const r = await w.ingest();
    expect(r).toMatchObject({ status: 'activated', previous_feed_version_id: 2 });
    expect(await statuses(w.db)).toEqual(['1:retired', '2:retired', '3:active']);
  });
});
