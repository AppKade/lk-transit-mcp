import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RealtimeHub, createReplaySource } from '../../src/index.js';
import { CAPTURE, T0, activateFeed, createDb, fakeClock, fixture, provider, resetStatic, routeId, seed, tripUpdatesFeed, vehiclesFeed, type TestDb } from './harness.js';

const realFrame = () => ({ vehicle_positions: fixture.vehicles(), trip_updates: fixture.tripUpdates(), alerts: fixture.alerts() });

describe('resolution of the real LMT capture', () => {
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

  it('polls the three fixtures and resolves by route short name', async () => {
    const clock = fakeClock();
    const src = createReplaySource(provider, [realFrame()]);
    const hub = new RealtimeHub({ provider, db, clock, fetchImpl: src.fetch });
    const res = await hub.pollOnce();

    expect(res.ok).toBe(true);
    expect(res.notes).toEqual([]);
    expect(res.resolved_against_feed_version).toBe('2026-10-20T03:00Z-ab12cd');
    expect(Object.values(res.feeds).map((f) => f.status)).toEqual(['updated', 'updated', 'updated']);
    expect(res.next_poll_in_ms).toBe(15_000);

    const snap = await hub.getSnapshot('lmt');
    expect(snap.provider).toBe('lmt');
    expect(snap.vehicles).toHaveLength(68);
    expect(snap.tripUpdates).toHaveLength(68);
    expect(snap.alerts).toHaveLength(0);

    expect(snap.quality).toEqual({
      vehicle_orphan_ratio: 0,
      trip_update_orphan_ratio: 0,
      resolved_against_feed_version: '2026-10-20T03:00Z-ab12cd',
    });
    expect(snap.vehicles.every((v) => v.resolution.method === 'route_short_name')).toBe(true);
    expect(snap.tripUpdates.every((t) => t.resolution.method === 'route_short_name')).toBe(true);

    const v0 = snap.vehicles.find((v) => v.trip_id === 'LMT_CM01_0_WP-NE-5208')!;
    expect(v0.resolution).toEqual({ route_id: routeId('CM01'), direction_id: 0, static_trip_id: null, method: 'route_short_name' });
    const tu0 = snap.tripUpdates.find((t) => t.trip_id === 'LMT_CM03_0_WP-NE-6542')!;
    expect(tu0.resolution.route_id).toBe(routeId('CM03'));
    // every vehicle's resolved route agrees with the short name in its trip id
    for (const v of snap.vehicles) {
      expect(v.resolution.route_id).toBe(routeId(v.trip_id!.split('_')[1]!));
      expect(v.resolution.direction_id).toBe(Number(v.trip_id!.split('_')[2]));
    }

    expect(snap.feeds.vehicle_positions).toEqual({
      ok: true,
      last_attempt_ms: T0,
      last_success_ms: T0,
      header_timestamp_ms: CAPTURE.vehicles * 1000,
      entity_count: 68,
      quarantined_count: 0,
      consecutive_failures: 0,
      last_error: null,
    });
    expect(snap.feeds.trip_updates.header_timestamp_ms).toBe(CAPTURE.tripUpdates * 1000);
    expect(snap.feeds.alerts).toMatchObject({ ok: true, entity_count: 0 });

    const m = hub.getMetrics();
    expect(m).toMatchObject({ polls_total: 3, polls_failed_total: 0, quarantined_total: 0, decode_errors_total: 0 });
  });

  it('only calls the configured URLs, with a protobuf accept header', async () => {
    const src = createReplaySource(provider, [realFrame()]);
    const hub = new RealtimeHub({ provider, db, clock: fakeClock(), fetchImpl: src.fetch });
    await hub.pollOnce();
    const configured = new Set(provider.sources.filter((s) => s.kind === 'gtfs_realtime').map((s) => s.url));
    expect(src.calls).toHaveLength(3);
    expect(src.calls.every((c) => configured.has(c.url))).toBe(true);
    expect(src.calls[0]!.headers.accept).toContain('protobuf');
  });

  it('prefers an exact static trip_id match, then a route_id match, then the short name', async () => {
    const d = db;
    await resetStatic(d);
    await activateFeed(d, 'v1', undefined, [{ id: 'LMT_CM01_0_EXACT', route: routeId('CM01'), direction: 1 }]);
    const t = 1792499745;
    const frame = {
      vehicle_positions: vehiclesFeed(t, [
        { id: 'a', trip: 'LMT_CM01_0_EXACT' },
        { id: 'b', trip: 'WHATEVER', routeId: routeId('CM02') },
        { id: 'c', trip: 'LMT_cm05_1_X' },
        { id: 'd', trip: 'LMT_CM99_0_X' },
        { id: 'e' },
      ]),
      trip_updates: tripUpdatesFeed(t, [{ id: 'x', trip: 'LMT_CM01_0_EXACT', route: 'CM01' }, { id: 'y', trip: 'T2', route: 'CM08' }]),
    };
    const hub = new RealtimeHub({ provider, db: d, clock: fakeClock(), fetchImpl: createReplaySource(provider, [frame]).fetch });
    await hub.pollOnce();
    const snap = await hub.getSnapshot();
    const by = Object.fromEntries(snap.vehicles.map((v) => [v.entity_id, v.resolution]));
    expect(by['a']).toEqual({ route_id: routeId('CM01'), direction_id: 1, static_trip_id: 'LMT_CM01_0_EXACT', method: 'trip_id' });
    expect(by['b']).toEqual({ route_id: routeId('CM02'), direction_id: null, static_trip_id: null, method: 'route_id' });
    expect(by['c']).toEqual({ route_id: routeId('CM05'), direction_id: 1, static_trip_id: null, method: 'route_short_name' });
    expect(by['d']!.method).toBe('unresolved');
    expect(by['d']!.route_id).toBeNull();
    expect(by['e']!.method).toBe('unresolved');
    expect(snap.quality.vehicle_orphan_ratio).toBeCloseTo(2 / 5);
    expect(snap.tripUpdates.map((x) => x.resolution.method)).toEqual(['trip_id', 'route_short_name']);
    expect(snap.quality.trip_update_orphan_ratio).toBe(0);
  });

  it('marks everything unresolved when there is no active static feed, without dropping data', async () => {
    await resetStatic(db);
    const d = db;
    const hub = new RealtimeHub({ provider, db: d, clock: fakeClock(), fetchImpl: createReplaySource(provider, [realFrame()]).fetch });
    const res = await hub.pollOnce();
    expect(res.ok).toBe(true);
    expect(res.notes).toContain('no_active_feed');
    expect(res.resolved_against_feed_version).toBeNull();
    const snap = await hub.getSnapshot();
    expect(snap.vehicles).toHaveLength(68);
    expect(snap.vehicles.every((v) => v.resolution.method === 'unresolved')).toBe(true);
    expect(snap.quality).toEqual({ vehicle_orphan_ratio: 1, trip_update_orphan_ratio: 1, resolved_against_feed_version: null });
  });

  it('re-resolves held data when the active feed version changes', async () => {
    const d = db;
    await resetStatic(d);
    await seed(d, 'v1');
    const src = createReplaySource(provider, [realFrame(), { vehicle_positions: { status: 500 }, trip_updates: { status: 500 }, alerts: { status: 500 } }]);
    const clock = fakeClock();
    const hub = new RealtimeHub({ provider, db: d, clock, fetchImpl: src.fetch });
    await hub.pollOnce();
    expect((await hub.getSnapshot()).quality.resolved_against_feed_version).toBe('v1');

    // a new static feed with different route ids goes live; the next poll fails entirely
    await activateFeed(d, 'v2', [['new-cm01', 'CM01'], ['new-cm03', 'CM03']]);
    clock.advance(15_000);
    const res = await hub.pollOnce();
    expect(res.ok).toBe(false);
    expect(res.notes).toEqual(expect.arrayContaining([expect.stringContaining('feed_version_changed')]));
    const snap = await hub.getSnapshot();
    expect(snap.quality.resolved_against_feed_version).toBe('v2');
    expect(snap.vehicles).toHaveLength(68);
    const cm01 = snap.vehicles.find((v) => v.route_id_raw === 'CM01')!;
    expect(cm01.resolution.route_id).toBe('new-cm01');
    // CM02 does not exist in v2: orphaned and counted
    expect(snap.vehicles.find((v) => v.route_id_raw === 'CM02')!.resolution.method).toBe('unresolved');
    expect(snap.quality.vehicle_orphan_ratio).toBeGreaterThan(0);
  });
});
