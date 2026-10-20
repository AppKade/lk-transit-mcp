import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { THRESHOLDS, computeFreshness, type Db, type RealtimeFeedKey } from '@lkt/core';
import { RealtimeHub, createReplaySource, type ReplayFrame } from '../../src/index.js';
import { CAPTURE, T0, alertsFeed, createDb, fakeClock, fixture, provider, resetStatic, seed, tripUpdatesFeed, vehiclesFeed, type TestDb, type V } from './harness.js';

const real: ReplayFrame = { vehicle_positions: fixture.vehicles(), trip_updates: fixture.tripUpdates(), alerts: fixture.alerts() };
const garbage = new TextEncoder().encode('<html><body><h1>502 Bad Gateway</h1></body></html>');
const sec = (ms: number) => Math.floor(ms / 1000);

let db: TestDb;
beforeAll(async () => {
  db = await createDb();
});
beforeEach(async () => {
  await resetStatic(db);
  await seed(db);
});
afterAll(async () => {
  await db.close();
});

describe('one feed failing does not affect the others', () => {
  it('garbage bytes and HTTP 500 keep the previous good entities', async () => {
    const clock = fakeClock();
    const src = createReplaySource(provider, [
      real,
      { vehicle_positions: garbage, trip_updates: { status: 500, body: 'oops' }, alerts: alertsFeed(CAPTURE.alerts + 20, [{ id: 'al1', text: 'Delays on CM01' }]) },
    ]);
    const hub = new RealtimeHub({ provider, db, clock, fetchImpl: src.fetch });
    await hub.pollOnce();
    clock.advance(15_000);
    const res = await hub.pollOnce();

    expect(res.ok).toBe(false);
    expect(res.feeds.vehicle_positions.status).toBe('failed');
    expect(res.feeds.vehicle_positions.error).toMatch(/decode/);
    expect(res.feeds.trip_updates).toMatchObject({ status: 'failed', error: 'HTTP 500' });
    expect(res.feeds.alerts.status).toBe('updated');

    const snap = await hub.getSnapshot();
    expect(snap.vehicles).toHaveLength(68);
    expect(snap.tripUpdates).toHaveLength(68);
    expect(snap.alerts.map((a) => a.header)).toEqual(['Delays on CM01']);
    expect(snap.feeds.vehicle_positions).toMatchObject({
      ok: false,
      consecutive_failures: 1,
      header_timestamp_ms: CAPTURE.vehicles * 1000, // still the last good payload's
      last_success_ms: T0,
      last_attempt_ms: T0 + 15_000,
      entity_count: 68,
    });
    expect(snap.feeds.trip_updates).toMatchObject({ ok: false, consecutive_failures: 1, last_error: 'HTTP 500' });
    expect(snap.feeds.alerts).toMatchObject({ ok: true, consecutive_failures: 0, last_error: null, header_timestamp_ms: (CAPTURE.alerts + 20) * 1000 });
    expect(hub.getMetrics()).toMatchObject({ polls_total: 6, polls_failed_total: 2, decode_errors_total: 1, fetch_errors_total: 1 });
  });

  it('times out a hanging feed and survives network errors', async () => {
    const clock = fakeClock();
    const src = createReplaySource(provider, [real, { vehicle_positions: { hang: true }, trip_updates: { error: 'ECONNRESET' } }]);
    const hub = new RealtimeHub({ provider, db, clock, fetchImpl: src.fetch, timeoutMs: 25 });
    await hub.pollOnce();
    clock.advance(15_000);
    const t0 = Date.now();
    const res = await hub.pollOnce();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res.feeds.vehicle_positions.error).toMatch(/timeout after 25ms/);
    expect(res.feeds.trip_updates.error).toBe('ECONNRESET');
    expect(res.feeds.alerts.status).toBe('updated');
    expect((await hub.getSnapshot()).vehicles).toHaveLength(68);
  });

  it('never throws, even if the fetch implementation is broken or the first poll fails', async () => {
    const hub = new RealtimeHub({
      provider,
      db,
      clock: fakeClock(),
      fetchImpl: (() => {
        throw new Error('sync boom');
      }) as unknown as typeof fetch,
    });
    const res = await hub.pollOnce();
    expect(res.ok).toBe(false);
    const snap = await hub.getSnapshot();
    expect(snap.vehicles).toEqual([]);
    expect(snap.feeds.vehicle_positions).toMatchObject({ ok: false, header_timestamp_ms: null, last_error: 'sync boom' });
  });

  it('ignores a payload with a header from the future and one with no header timestamp', async () => {
    const clock = fakeClock();
    const future = vehiclesFeed(sec(T0) + 3600, [{ id: 'a', trip: 'LMT_CM01_0_X' }]);
    const hub = new RealtimeHub({ provider, db, clock, fetchImpl: createReplaySource(provider, [real, { vehicle_positions: future }]).fetch });
    await hub.pollOnce();
    clock.advance(15_000);
    const res = await hub.pollOnce();
    expect(res.feeds.vehicle_positions.error).toMatch(/future/);
    expect((await hub.getSnapshot()).vehicles).toHaveLength(68);
  });
});

describe('freshness consequences', () => {
  it('data kept through an outage ages into stale from header and observed_at, and recovers', async () => {
    const clock = fakeClock();
    const down: ReplayFrame = { vehicle_positions: { status: 503 }, trip_updates: { status: 503 }, alerts: { status: 503 } };
    const recovered = sec(T0) + 140;
    const src = createReplaySource(provider, [
      real,
      down,
      down,
      down,
      { vehicle_positions: vehiclesFeed(recovered, [{ id: 'a', trip: 'LMT_CM01_0_X' }]), trip_updates: tripUpdatesFeed(recovered, [{ id: 't', trip: 'LMT_CM01_0_X', route: 'CM01' }]), alerts: alertsFeed(recovered, []) },
    ]);
    const hub = new RealtimeHub({ provider, db, clock, fetchImpl: src.fetch });
    const fresh = (snap: Awaited<ReturnType<typeof hub.getSnapshot>>) => ({
      header: computeFreshness(snap.feeds.vehicle_positions.header_timestamp_ms, clock.now(), THRESHOLDS.vehicleSeconds),
      entity: computeFreshness(Math.max(...snap.vehicles.map((v) => v.observed_at_ms)), clock.now(), THRESHOLDS.vehicleSeconds),
      trips: computeFreshness(snap.feeds.trip_updates.header_timestamp_ms, clock.now(), THRESHOLDS.tripUpdateSeconds),
    });

    await hub.pollOnce();
    let f = fresh(await hub.getSnapshot());
    expect(f.header).toMatchObject({ status: 'fresh', age_seconds: 15 });
    expect(f.entity.status).toBe('fresh');

    // outage: three failed polls, spaced beyond the backoff windows
    for (const step of [30_000, 60_000, 60_000]) {
      clock.advance(step);
      const r = await hub.pollOnce();
      expect(r.feeds.vehicle_positions.status).toBe('failed');
    }
    const snap = await hub.getSnapshot();
    expect(snap.vehicles).toHaveLength(68); // still served, but...
    f = fresh(snap);
    expect(f.header).toMatchObject({ status: 'stale', age_seconds: 15 + 150 });
    expect(f.entity.status).toBe('stale');
    expect(f.trips.status).toBe('stale');

    clock.advance(1000);
    await hub.pollOnce({ force: true });
    const after = await hub.getSnapshot();
    expect(after.vehicles).toHaveLength(1);
    expect(fresh(after).header.status).toBe('fresh');
    expect(after.feeds.vehicle_positions.consecutive_failures).toBe(0);
  });

  it('a 90 s lull with healthy HTTP is still stale: freshness follows the payload, not the fetch', async () => {
    const clock = fakeClock();
    // upstream keeps answering 200 with the same old payload
    const hub = new RealtimeHub({ provider, db, clock, fetchImpl: createReplaySource(provider, [real]).fetch });
    await hub.pollOnce();
    clock.advance(120_000);
    const res = await hub.pollOnce();
    expect(res.ok).toBe(true);
    const snap = await hub.getSnapshot();
    expect(snap.feeds.vehicle_positions.last_success_ms).toBe(clock.now());
    expect(computeFreshness(snap.feeds.vehicle_positions.header_timestamp_ms, clock.now(), THRESHOLDS.vehicleSeconds).status).toBe('stale');
  });
});

describe('consecutive failures and backoff', () => {
  it('backs off exponentially per feed, caps, skips feeds inside their window and resets on success', async () => {
    const clock = fakeClock();
    const bad: ReplayFrame = { trip_updates: { status: 500 } };
    const frames: ReplayFrame[] = [real, ...Array(7).fill(bad), { trip_updates: fixture.tripUpdates() }];
    const src = createReplaySource(provider, frames);
    const hub = new RealtimeHub({ provider, db, clock, fetchImpl: src.fetch });
    const first = await hub.pollOnce();
    expect(first.next_poll_in_ms).toBe(15_000);

    const expected = [30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000];
    for (const [i, backoff] of expected.entries()) {
      clock.advance(15_000);
      const r = await hub.pollOnce({ force: true });
      expect(r.feeds.trip_updates).toMatchObject({ status: 'failed', next_attempt_in_ms: backoff });
      expect((await hub.getSnapshot()).feeds.trip_updates.consecutive_failures).toBe(i + 1);
      // healthy feeds keep their normal cadence, so the poll loop is not slowed down
      expect(r.next_poll_in_ms).toBe(15_000);
    }

    // inside the 300 s window the failing feed is skipped without a request
    const before = src.fetched('trip_updates');
    clock.advance(15_000);
    const skipped = await hub.pollOnce();
    expect(skipped.feeds.trip_updates.status).toBe('skipped');
    expect(skipped.feeds.trip_updates.next_attempt_in_ms).toBe(285_000);
    expect(skipped.feeds.vehicle_positions.status).toBe('updated');
    expect(src.fetched('trip_updates')).toBe(before);

    // once due, a good payload resets the counter
    clock.advance(285_000);
    const ok = await hub.pollOnce();
    expect(ok.feeds.trip_updates.status).toBe('updated');
    expect((await hub.getSnapshot()).feeds.trip_updates).toMatchObject({ ok: true, consecutive_failures: 0, last_error: null });
    expect(hub.getMetrics().by_feed.trip_updates).toMatchObject({ failed: 7 });
  });

  it('when every feed fails the next poll waits for the backoff', async () => {
    const clock = fakeClock();
    const down: ReplayFrame = { vehicle_positions: { status: 500 }, trip_updates: { status: 500 }, alerts: { status: 500 } };
    const hub = new RealtimeHub({ provider, db, clock, fetchImpl: createReplaySource(provider, [down]).fetch });
    expect((await hub.pollOnce()).next_poll_in_ms).toBe(30_000);
    clock.advance(30_000);
    expect((await hub.pollOnce()).next_poll_in_ms).toBe(60_000);
  });

  it('idle polling relaxes to 60 s and recommendedIntervalMs follows query activity', async () => {
    const clock = fakeClock();
    const hub = new RealtimeHub({ provider, db, clock, fetchImpl: createReplaySource(provider, [real]).fetch });
    expect((await hub.pollOnce({ idle: true })).next_poll_in_ms).toBe(60_000);
    expect(hub.recommendedIntervalMs(clock.now() - 1000)).toBe(15_000);
    expect(hub.recommendedIntervalMs(clock.now() - 9 * 60_000)).toBe(15_000);
    expect(hub.recommendedIntervalMs(clock.now() - 11 * 60_000)).toBe(60_000);
    expect(hub.recommendedIntervalMs(null)).toBe(60_000);
  });

  it('coalesces concurrent polls into one fetch round', async () => {
    const src = createReplaySource(provider, [real]);
    const hub = new RealtimeHub({ provider, db, clock: fakeClock(), fetchImpl: src.fetch });
    const [a, b] = await Promise.all([hub.pollOnce(), hub.pollOnce()]);
    expect(a).toBe(b);
    expect(src.fetched('vehicle_positions')).toBe(1);
  });
});

describe('exportState / importState', () => {
  it('round-trips through JSON so a restarted hub does not blank the map', async () => {
    const clock = fakeClock();
    const hub = new RealtimeHub({ provider, db, clock, fetchImpl: createReplaySource(provider, [real, { trip_updates: { status: 500 } }]).fetch });
    await hub.pollOnce();
    clock.advance(15_000);
    await hub.pollOnce();
    const state = JSON.parse(JSON.stringify(hub.exportState()));
    expect(state.version).toBe(1);

    const reborn = new RealtimeHub({ provider, db, clock, fetchImpl: createReplaySource(provider, [{ vehicle_positions: { status: 500 } }]).fetch });
    expect((await reborn.getSnapshot()).vehicles).toEqual([]);
    expect(reborn.importState(state)).toBe(true);
    expect(await reborn.getSnapshot()).toEqual(await hub.getSnapshot());
    expect(reborn.getMetrics()).toEqual(hub.getMetrics());
    expect(reborn.exportState()).toEqual(hub.exportState());

    // the first poll after the restart fails: old data (and its true age) is still there
    clock.advance(200_000);
    const r = await reborn.pollOnce({ force: true });
    expect(r.ok).toBe(false);
    const snap = await reborn.getSnapshot();
    expect(snap.vehicles).toHaveLength(68);
    expect(snap.quality.resolved_against_feed_version).toBe('2026-10-20T03:00Z-ab12cd');
    expect(computeFreshness(snap.feeds.vehicle_positions.header_timestamp_ms, clock.now(), 90).status).toBe('stale');
  });

  it('rejects incompatible state without changing anything', async () => {
    const hub = new RealtimeHub({ provider, db, clock: fakeClock(), fetchImpl: createReplaySource(provider, [real]).fetch });
    await hub.pollOnce();
    const good = hub.exportState();
    const other = new RealtimeHub({ provider, db, clock: fakeClock() });
    expect(other.importState({ ...good, provider: 'sltb' })).toBe(false);
    expect(other.importState({ ...good, version: 2 } as never)).toBe(false);
    expect(other.importState({ junk: true } as never)).toBe(false);
    expect(other.importState(null as never)).toBe(false);
    expect((await other.getSnapshot()).vehicles).toEqual([]);
  });

  it('getSnapshot returns copies and is empty for another provider', async () => {
    const hub = new RealtimeHub({ provider, db, clock: fakeClock(), fetchImpl: createReplaySource(provider, [real]).fetch });
    expect((await hub.getSnapshot()).feeds.alerts.header_timestamp_ms).toBeNull();
    await hub.pollOnce();
    const s1 = await hub.getSnapshot();
    s1.vehicles.length = 0;
    s1.feeds.vehicle_positions.entity_count = -1;
    const s2 = await hub.getSnapshot();
    expect(s2.vehicles).toHaveLength(68);
    expect(s2.feeds.vehicle_positions.entity_count).toBe(68);
    expect((await hub.getSnapshot('sltb')).vehicles).toEqual([]);
  });
});

describe('static lookup failures', () => {
  it('keeps polling and keeps the last good lookup when the database errors', async () => {
    let failing = false;
    const flaky: Db = {
      query: (sql, params) => (failing ? Promise.reject(new Error('neon unreachable')) : db.query(sql, params)),
      transaction: (fn) => db.transaction(fn),
    };
    const clock = fakeClock();
    const hub = new RealtimeHub({ provider, db: flaky, clock, fetchImpl: createReplaySource(provider, [real]).fetch });
    await hub.pollOnce();
    failing = true;
    clock.advance(15_000);
    const res = await hub.pollOnce();
    expect(res.ok).toBe(true);
    expect(res.notes.join()).toContain('static_lookup_failed');
    const snap = await hub.getSnapshot();
    expect(snap.vehicles.every((v) => v.resolution.method === 'route_short_name')).toBe(true);
    expect(snap.quality.resolved_against_feed_version).toBe('2026-10-20T03:00Z-ab12cd');

    const cold = new RealtimeHub({ provider, db: flaky, clock, fetchImpl: createReplaySource(provider, [real]).fetch });
    const r2 = await cold.pollOnce();
    expect(r2.ok).toBe(true);
    expect((await cold.getSnapshot()).quality.vehicle_orphan_ratio).toBe(1);
  });
});

describe('replay of a multi-frame sequence', () => {
  const base = 1792499700;
  const ts = (i: number) => base + 15 * i;
  const veh = (i: number, extra: V[] = []) =>
    vehiclesFeed(ts(i), [{ id: 'a', trip: 'LMT_CM01_0_A', lat: 6.9 + i / 100 }, { id: 'b', trip: 'LMT_CM03_1_B', lon: 79.95 }, ...extra]);

  it('tracks movement, quarantine counts, lagging replicas and 304s deterministically', async () => {
    const clock = fakeClock((ts(0) + 3) * 1000);
    const frames: ReplayFrame[] = [
      { vehicle_positions: veh(0), trip_updates: tripUpdatesFeed(ts(0), [{ id: 'x', trip: 'LMT_CM01_0_A', route: 'CM01' }]), alerts: alertsFeed(ts(0), [{ id: 'al1', text: 'Heavy traffic' }]) },
      {
        vehicle_positions: veh(1, [{ id: 'bad', trip: 'LMT_CM01_0_C', lat: 95 }, { id: 'future', trip: 'LMT_CM01_0_D', ts: ts(1) + 3600 }]),
        trip_updates: tripUpdatesFeed(ts(1), [{ id: 'x', trip: 'LMT_CM01_0_A', route: 'CM01' }, { id: 'x', trip: 'LMT_CM01_0_A', route: 'CM01' }]),
        alerts: alertsFeed(ts(1), [{ id: 'al1', text: 'Heavy traffic' }, { id: 'al2' }]),
      },
      { vehicle_positions: veh(0) }, // a lagging replica answers with the frame-0 payload
      { vehicle_positions: { status: 304 } },
      { vehicle_positions: veh(4) },
    ];
    const src = createReplaySource(provider, frames);
    const hub = new RealtimeHub({ provider, db, clock, fetchImpl: src.fetch });
    const pos = async () => (await hub.getSnapshot()).vehicles.find((v) => v.entity_id === 'a')!.latitude;

    const p0 = await hub.pollOnce();
    expect(p0.quarantined).toEqual([]);
    expect(await pos()).toBeCloseTo(6.9);

    clock.advance(15_000);
    const p1 = await hub.pollOnce();
    expect(p1.feeds.vehicle_positions).toMatchObject({ status: 'updated', entity_count: 2, quarantined_count: 2 });
    expect(p1.quarantined.map((q) => `${q.feed}:${q.entity_id}:${q.reason}`)).toEqual([
      'vehicle_positions:bad:invalid_coordinates',
      'vehicle_positions:future:timestamp_in_future',
      'trip_updates:x:duplicate_entity_id',
      'alerts:al2:missing_text',
    ]);
    expect(await pos()).toBeCloseTo(6.91);
    const snap1 = await hub.getSnapshot();
    expect(snap1.feeds.trip_updates).toMatchObject({ entity_count: 1, quarantined_count: 1 });
    expect(snap1.alerts).toHaveLength(1);

    clock.advance(15_000);
    const p2 = await hub.pollOnce();
    expect(p2.feeds.vehicle_positions.status).toBe('older_payload');
    expect(await pos()).toBeCloseTo(6.91); // newer data kept
    expect((await hub.getSnapshot()).feeds.vehicle_positions.header_timestamp_ms).toBe(ts(1) * 1000);

    clock.advance(15_000);
    expect((await hub.pollOnce()).feeds.vehicle_positions.status).toBe('not_modified');
    expect(await pos()).toBeCloseTo(6.91);

    clock.advance(15_000);
    expect((await hub.pollOnce()).feeds.vehicle_positions.status).toBe('updated');
    expect(await pos()).toBeCloseTo(6.94);

    const m = hub.getMetrics();
    // feeds left out of a frame re-serve their previous payload, so frame 1's trip/alert problems recur on each poll
    expect(m.quarantined_total).toBe(10);
    expect(m.quarantine_by_reason).toEqual({
      invalid_coordinates: 1,
      timestamp_in_future: 1,
      duplicate_entity_id: 4,
      missing_text: 4,
    });
    expect(m).toMatchObject({ not_modified_total: 1, older_payload_total: 1, polls_failed_total: 0 });
  });

  it('follows upstream after three consecutive older payloads (header went backwards for real)', async () => {
    const clock = fakeClock((ts(10) + 3) * 1000);
    const frames: ReplayFrame[] = [{ vehicle_positions: veh(10) }, { vehicle_positions: veh(2) }];
    const hub = new RealtimeHub({ provider, db, clock, fetchImpl: createReplaySource(provider, frames).fetch });
    const statuses: string[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await hub.pollOnce({ force: true })).feeds.vehicle_positions.status);
      clock.advance(15_000);
    }
    expect(statuses).toEqual(['updated', 'older_payload', 'older_payload', 'updated']);
    expect((await hub.getSnapshot()).feeds.vehicle_positions.header_timestamp_ms).toBe(ts(2) * 1000);
  });

  it('samples 1 in N raw payloads, including undecodable ones', async () => {
    const puts: string[] = [];
    const clock = fakeClock();
    const frames: ReplayFrame[] = [real, real, { vehicle_positions: garbage }, real];
    const hub = new RealtimeHub({
      provider,
      db,
      clock,
      fetchImpl: createReplaySource(provider, frames).fetch,
      sampler: {
        every: 2,
        put: async (key, bytes) => {
          expect(bytes.byteLength).toBeGreaterThan(0);
          puts.push(key);
        },
      },
    });
    for (let i = 0; i < 4; i++) {
      await hub.pollOnce({ force: true });
      clock.advance(15_000);
    }
    // fetches 0 and 2 of each feed are sampled; fetch 2 of the vehicles feed is the garbage payload
    expect(puts).toHaveLength(6);
    for (const feed of ['vehicle_positions', 'trip_updates', 'alerts']) {
      expect(puts.filter((k) => k.startsWith(`lmt/${feed}/`))).toHaveLength(2);
    }
    expect(hub.getMetrics().decode_errors_total).toBe(1);
  });

  it('a failing sampler is counted and never fails the poll', async () => {
    const hub = new RealtimeHub({
      provider,
      db,
      clock: fakeClock(),
      fetchImpl: createReplaySource(provider, [real]).fetch,
      sampler: { every: 1, put: () => Promise.reject(new Error('r2 down')) },
    });
    const r = await hub.pollOnce();
    expect(r.ok).toBe(true);
    expect(hub.getMetrics().sampler_errors_total).toBe(3);
    expect((await hub.getSnapshot()).vehicles).toHaveLength(68);
  });
});

it('replay source 404s unknown feeds and records calls', async () => {
  const src = createReplaySource(provider, []);
  const hub = new RealtimeHub({ provider, db, clock: fakeClock(), fetchImpl: src.fetch });
  const r = await hub.pollOnce();
  expect(r.ok).toBe(false);
  expect(Object.values(r.feeds).every((f) => f.error === 'HTTP 404')).toBe(true);
  const keys: RealtimeFeedKey[] = ['vehicle_positions', 'trip_updates', 'alerts'];
  expect(keys.map((k) => src.fetched(k))).toEqual([1, 1, 1]);
});
