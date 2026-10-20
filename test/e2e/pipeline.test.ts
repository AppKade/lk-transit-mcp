import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LMT, type Clock } from '@lkt/core';
import { createPgliteDb, migrate } from '@lkt/db';
import { RealtimeHub, ensureProvider, runStaticIngest } from '@lkt/ingest';
import { createTransitQueries, type TransitQueries } from '@lkt/query';

const fx = (name: string) => new Uint8Array(readFileSync(new URL(`../../fixtures/lmt/${name}`, import.meta.url)));
const BY_URL: Record<string, Uint8Array> = Object.fromEntries(
  LMT.sources.map((s) => [
    s.url,
    fx(s.kind === 'gtfs_static' ? 'gtfs.zip' : `${s.feed!.replace('_', '-')}.pb`),
  ]),
);
const fakeFetch = (async (url: string | URL | Request) => {
  const body = BY_URL[String(url)];
  return body ? new Response(body, { status: 200 }) : new Response('nope', { status: 404 });
}) as typeof fetch;

// The fixtures were captured with a feed header timestamp of 1792499730 (s).
const CAPTURE_MS = 1_792_499_730_000;
let nowMs = CAPTURE_MS + 5_000;
const clock: Clock = { now: () => nowMs };

describe('recorded LMT feeds, end to end', () => {
  let db: Awaited<ReturnType<typeof createPgliteDb>>;
  let q: TransitQueries;
  let hub: RealtimeHub;

  beforeAll(async () => {
    db = await createPgliteDb();
    await migrate(db);
    await ensureProvider(db, LMT);
    const r = await runStaticIngest({ db, provider: LMT, clock, fetchImpl: fakeFetch });
    expect(r.status).toBe('activated');
    hub = new RealtimeHub({ provider: LMT, db, clock, fetchImpl: fakeFetch });
    await hub.pollOnce({ force: true });
    q = createTransitQueries({ db, realtime: hub, clock, providers: { lmt: LMT }, defaultProvider: 'lmt' });
  }, 120_000);
  afterAll(async () => { await db.close(); });

  it('resolves live data against the static feed (trip ids differ, route short names match)', async () => {
    const snap = await hub.getSnapshot('lmt');
    expect(snap.vehicles.length).toBe(68);
    expect(snap.tripUpdates.length).toBe(68);
    expect(snap.quality.vehicle_orphan_ratio).toBeLessThan(0.005);
    expect(snap.quality.trip_update_orphan_ratio).toBeLessThan(0.005);
    expect(snap.vehicles.every((v) => v.speed_mps === null || v.speed_mps < 30)).toBe(true);
  });

  it('reports a healthy feed with provenance', async () => {
    const s = await q.getFeedStatus({});
    expect(s.provider).toBe('lmt');
    expect(s.source.license).toBe('CC-BY-4.0');
    expect(s.source.provider_authority).toBe('unconfirmed');
    expect(s.data.static.active_feed_version).toMatch(/-[0-9a-f]{6}$/);
    expect(s.data.realtime.vehicle_positions.entity_count).toBe(68);
    expect(s.data.overall).not.toBe('down');
  });

  it('finds Pettah stops nearby and shows routes', async () => {
    const r = await q.findStopsNearby({ latitude: 6.93444, longitude: 79.85492, radius_m: 600, limit: 5 });
    expect(r.data.length).toBeGreaterThan(0);
    expect(r.data[0]!.stop_id).toMatch(/^lmt:stop:/);
    expect(r.data[0]!.distance_m).toBeLessThan(600);
  });

  it('serves live vehicles with freshness', async () => {
    const v = await q.getVehiclePositions({ max_age_seconds: 600 });
    expect(v.data.length).toBeGreaterThan(0);
    expect(v.data[0]!.route).not.toBeNull();
    expect(v.freshness.status).toBe('fresh');
  });

  it('merges provider-live predictions into arrivals for a stop with live updates', async () => {
    const a = await q.getArrivals({ stop_id: '69', within_minutes: 120, limit: 100 });
    const types = new Set(a.data.map((x) => x.prediction_type));
    expect(types.has('provider_live')).toBe(true);
    expect(a.freshness.status).toBe('fresh');
  });

  it('refuses to present old live data as live', async () => {
    nowMs = CAPTURE_MS + 10 * 60_000;
    const a = await q.getArrivals({ stop_id: '69', within_minutes: 120, limit: 100 });
    expect(a.data.some((x) => x.prediction_type === 'provider_live')).toBe(false);
    expect(a.freshness.status).not.toBe('fresh');
    const s = await q.getFeedStatus({});
    expect(s.data.realtime.vehicle_positions.freshness).toBe('stale');
    nowMs = CAPTURE_MS + 5_000;
  });
});
