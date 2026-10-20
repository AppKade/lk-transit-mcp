import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@lkt/core';
import { NOW, ROUTE_UUID, alert, feed, harness, resolved, setupDb, snapshotOf, vehicle } from './seed.js';
import type { Harness } from './seed.js';

const SEC = 1000;
const MIN = 60_000;

describe('realtime-backed queries', () => {
  let db: Db & { close(): Promise<void> };
  let h: Harness;
  beforeAll(async () => {
    db = await setupDb();
    h = harness(db);
  }, 60_000);
  afterAll(async () => { await db.close(); });
  const reset = () => { h.clock.set(NOW); h.rt.snapshot = snapshotOf({}); h.rt.failing = false; };

  describe('getVehiclePositions', () => {
    function fleet() {
      h.rt.snapshot = snapshotOf(
        {
          vehicles: [
            vehicle({ entity_id: 'v1', label: 'CM01-1', observed_at_ms: NOW - 20 * SEC, latitude: 6.93, longitude: 79.85, speed_mps: 10, trip_id: 'LMT_CM01_0_WP-NE-5208', occupancy_status: 'FEW_SEATS_AVAILABLE', occupancy_percentage: 70 }),
            vehicle({ entity_id: 'v2', observed_at_ms: NOW - 120 * SEC, latitude: 6.95, longitude: 79.9, resolution: resolved(ROUTE_UUID.CM02, 1), direction_id: 1 }),
            vehicle({ entity_id: 'v3', observed_at_ms: NOW - 400 * SEC, latitude: 7.2, longitude: 80.1, resolution: resolved(null, null) }),
            vehicle({ entity_id: 'v4', observed_at_ms: NOW - 5 * SEC, latitude: 6.91, longitude: 79.86, speed_mps: null, resolution: { route_id: ROUTE_UUID.CM01, direction_id: 1, static_trip_id: 'TRIP_CM01_D1_T1', method: 'trip_id' } }),
          ],
        },
        { vehicle_positions: feed(NOW - 8 * SEC) },
      );
    }

    it('excludes vehicles older than max_age_seconds (default 90) and converts units', async () => {
      reset(); fleet();
      const r = await h.q.getVehiclePositions({ max_age_seconds: 90 });
      expect(r.data.map((v) => v.vehicle_id)).toEqual(['lmt:vehicle:v1', 'lmt:vehicle:v4']);
      expect(r.data[0]).toMatchObject({
        label: 'CM01-1', speed_kmh: 36, age_seconds: 20, freshness: 'fresh', occupancy_status: 'FEW_SEATS_AVAILABLE', occupancy_percentage: 70,
        provider_trip_ref: 'LMT_CM01_0_WP-NE-5208', observed_at: '2026-10-20T06:24:40+05:30', route: { short_name: 'CM01', route_id: `lmt:route:${ROUTE_UUID.CM01}` },
      });
      expect(r.data[1]!.speed_kmh).toBeNull();
      expect(r.source).toMatchObject({ type: 'gtfs_realtime', url_ref: ['lmt.vehicle_positions'] });
      expect(r.freshness).toEqual({ status: 'fresh', age_seconds: 8, threshold_seconds: 90 });
    });

    it('marks vehicles stale when the caller widens max_age_seconds', async () => {
      reset(); fleet();
      const r = await h.q.getVehiclePositions({ max_age_seconds: 300 });
      expect(r.data.map((v) => [v.vehicle_id, v.freshness])).toEqual([
        ['lmt:vehicle:v1', 'fresh'], ['lmt:vehicle:v2', 'stale'], ['lmt:vehicle:v4', 'fresh'],
      ]);
      const all = await h.q.getVehiclePositions({ max_age_seconds: 600 });
      expect(all.data.find((v) => v.vehicle_id === 'lmt:vehicle:v3')).toMatchObject({ freshness: 'stale', route: null });
    });

    it('filters by route (short name, uuid or canonical), trip reference and bbox', async () => {
      reset(); fleet();
      const ids = async (input: Parameters<typeof h.q.getVehiclePositions>[0]) => (await h.q.getVehiclePositions(input)).data.map((v) => v.vehicle_id);
      expect(await ids({ route_id: 'CM01', max_age_seconds: 300 })).toEqual(['lmt:vehicle:v1', 'lmt:vehicle:v4']);
      expect(await ids({ route_id: `lmt:route:${ROUTE_UUID.CM02}`, max_age_seconds: 300 })).toEqual(['lmt:vehicle:v2']);
      expect(await ids({ route_id: ROUTE_UUID.CM02, max_age_seconds: 300 })).toEqual(['lmt:vehicle:v2']);
      expect(await ids({ trip_id: 'LMT_CM01_0_WP-NE-5208', max_age_seconds: 300 })).toEqual(['lmt:vehicle:v1']);
      expect(await ids({ trip_id: 'lmt:trip:TRIP_CM01_D1_T1', max_age_seconds: 300 })).toEqual(['lmt:vehicle:v4']);
      expect(await ids({ bbox: [79.84, 6.92, 79.87, 6.94], max_age_seconds: 300 })).toEqual(['lmt:vehicle:v1']);
      expect(await ids({ bbox: [81, 7, 82, 8], max_age_seconds: 300 })).toEqual([]);
      await expect(h.q.getVehiclePositions({ route_id: 'CM99', max_age_seconds: 90 })).rejects.toMatchObject({ code: 'unknown_route' });
    });

    it('reports stale/unavailable feed freshness in the envelope', async () => {
      reset(); fleet();
      h.rt.snapshot.feeds.vehicle_positions = feed(NOW - 200 * SEC);
      expect((await h.q.getVehiclePositions({ max_age_seconds: 90 })).freshness).toEqual({ status: 'stale', age_seconds: 200, threshold_seconds: 90 });
      reset();
      const empty = await h.q.getVehiclePositions({ max_age_seconds: 90 });
      expect(empty.data).toEqual([]);
      expect(empty.freshness.status).toBe('unavailable');
    });
  });

  describe('getServiceAlerts', () => {
    const entity = (o: { route?: string; stop?: string; agency?: string }) => ({ agency_id: o.agency ?? null, route_id: o.route ?? null, stop_id: o.stop ?? null, trip_id: null });
    function alerts() {
      h.rt.snapshot = snapshotOf(
        {
          alerts: [
            alert({ entity_id: 'open', header: 'No periods', informed_entities: [entity({ route: 'CM01' })] }),
            alert({ entity_id: 'now', header: 'Active window', active_periods: [{ start_ms: NOW - MIN, end_ms: NOW + MIN }], informed_entities: [entity({ route: ROUTE_UUID.CM02 }), entity({ stop: '22' })] }),
            alert({ entity_id: 'future', active_periods: [{ start_ms: NOW + MIN, end_ms: NOW + 2 * MIN }], informed_entities: [entity({ route: 'CM01' })] }),
            alert({ entity_id: 'expired', active_periods: [{ start_ms: NOW - 2 * MIN, end_ms: NOW - MIN }], informed_entities: [entity({ route: 'CM01' })] }),
            alert({ entity_id: 'ended-now', active_periods: [{ start_ms: NOW - 2 * MIN, end_ms: NOW }], informed_entities: [entity({ route: 'CM01' })] }),
            alert({ entity_id: 'open-ended', active_periods: [{ start_ms: NOW - 5 * MIN, end_ms: null }], informed_entities: [entity({ route: 'CM03' })] }),
            alert({ entity_id: 'second-period', active_periods: [{ start_ms: NOW - 9 * MIN, end_ms: NOW - 8 * MIN }, { start_ms: NOW - MIN, end_ms: null }], informed_entities: [entity({ route: 'CM06' })] }),
            alert({ entity_id: 'network', header: 'Network wide', informed_entities: [entity({ agency: 'LMT' })] }),
          ],
        },
        { alerts: feed(NOW - 60 * SEC) },
      );
    }
    const ids = async (input: Parameters<typeof h.q.getServiceAlerts>[0]) => (await h.q.getServiceAlerts(input)).data.map((a) => a.alert_id.replace('lmt:alert:', '')).sort();

    it('returns only alerts active at now (empty periods = active, end exclusive)', async () => {
      reset(); alerts();
      expect(await ids({})).toEqual(['network', 'now', 'open', 'open-ended', 'second-period']);
    });

    it('canonicalises route and stop ids and reports the period', async () => {
      reset(); alerts();
      const r = await h.q.getServiceAlerts({});
      const now = r.data.find((a) => a.alert_id === 'lmt:alert:now')!;
      expect(now).toMatchObject({
        header: 'Active window', routes: [`lmt:route:${ROUTE_UUID.CM02}`], stops: ['lmt:stop:22'],
        active_from: '2026-10-20T06:24:00+05:30', active_until: '2026-10-20T06:26:00+05:30',
      });
      expect(r.data.find((a) => a.alert_id === 'lmt:alert:open')).toMatchObject({ routes: [`lmt:route:${ROUTE_UUID.CM01}`], active_from: null, active_until: null });
    });

    it('filters by route (any id form) and stop; network-wide alerts always match', async () => {
      reset(); alerts();
      expect(await ids({ route_id: 'CM01' })).toEqual(['network', 'open']);
      expect(await ids({ route_id: `lmt:route:${ROUTE_UUID.CM02}` })).toEqual(['network', 'now']);
      expect(await ids({ route_id: ROUTE_UUID.CM01 })).toEqual(['network', 'open']);
      expect(await ids({ stop_id: 'lmt:stop:22' })).toEqual(['network', 'now']);
      expect(await ids({ stop_id: '23' })).toEqual(['network']);
      await expect(h.q.getServiceAlerts({ route_id: 'CM99' })).rejects.toMatchObject({ code: 'unknown_route' });
      await expect(h.q.getServiceAlerts({ stop_id: '999999' })).rejects.toMatchObject({ code: 'unknown_stop' });
    });

    it('uses the 10 minute alert threshold', async () => {
      reset(); alerts();
      h.rt.snapshot.feeds.alerts = feed(NOW - 300 * SEC);
      expect((await h.q.getServiceAlerts({})).freshness).toEqual({ status: 'fresh', age_seconds: 300, threshold_seconds: 600 });
      h.rt.snapshot.feeds.alerts = feed(NOW - 700 * SEC);
      const stale = await h.q.getServiceAlerts({});
      expect(stale.freshness).toEqual({ status: 'stale', age_seconds: 700, threshold_seconds: 600 });
      expect(stale.source).toMatchObject({ type: 'gtfs_realtime', url_ref: ['lmt.alerts'] });
    });
  });

  describe('getFeedStatus', () => {
    const allFresh = () => ({ vehicle_positions: feed(NOW - 10 * SEC), trip_updates: feed(NOW - 12 * SEC), alerts: feed(NOW - 30 * SEC) });

    it('is healthy when everything is fresh', async () => {
      reset();
      h.rt.snapshot = snapshotOf({}, allFresh());
      const r = await h.q.getFeedStatus({});
      expect(r.data.overall).toBe('healthy');
      expect(r.data.static).toMatchObject({ active_feed_version: '2026-10-20T03:00Z-test01', calendar_end: '2027-12-31', calendar_days_remaining: 437, activated_at: '2026-10-20T05:30:00+05:30' });
      expect(r.data.static.counts).toMatchObject({ routes: 7, trips: 56 });
      expect(r.data.realtime.trip_updates).toMatchObject({ ok: true, freshness: 'fresh', header_age_seconds: 12 });
      expect(r.data.realtime.alerts.last_success).toBe('2026-10-20T06:24:30+05:30');
      expect(r.source).toMatchObject({ type: 'mixed', feed_version: '2026-10-20T03:00Z-test01' });
      expect(r.source.url_ref).toEqual(['lmt.gtfs', 'lmt.vehicle_positions', 'lmt.trip_updates', 'lmt.alerts']);
      expect(r.freshness).toEqual({ status: 'fresh', age_seconds: 12, threshold_seconds: 90 });
    });

    it('is degraded when a feed is stale, with a human readable note', async () => {
      reset();
      h.rt.snapshot = snapshotOf({}, { ...allFresh(), trip_updates: feed(NOW - 240 * SEC, { consecutive_failures: 3, ok: false }) });
      const r = await h.q.getFeedStatus({});
      expect(r.data.overall).toBe('degraded');
      expect(r.data.realtime.trip_updates).toMatchObject({ freshness: 'stale', header_age_seconds: 240, consecutive_failures: 3 });
      expect(r.data.notes.join('\n')).toMatch(/trip updates feed is stale \(240 s old, limit 90 s\); arrivals fall back to the timetable/);
      expect(r.freshness.status).toBe('stale');
    });

    it('is degraded when an orphan ratio exceeds 0.5%', async () => {
      reset();
      const snap = snapshotOf({}, allFresh());
      snap.quality.trip_update_orphan_ratio = 0.004;
      h.rt.snapshot = snap;
      expect((await h.q.getFeedStatus({})).data.overall).toBe('healthy');
      snap.quality.trip_update_orphan_ratio = 0.02;
      const r = await h.q.getFeedStatus({});
      expect(r.data.overall).toBe('degraded');
      expect(r.data.notes.join('\n')).toMatch(/2\.0% of trip updates could not be matched/);
    });

    it('is degraded when fewer than 14 days of calendar are left, and says so', async () => {
      reset();
      h.rt.snapshot = snapshotOf({}, allFresh());
      await db.query(`UPDATE feed_versions SET calendar_end = '2026-10-30'`);
      const r = await h.q.getFeedStatus({});
      await db.query(`UPDATE feed_versions SET calendar_end = '2027-12-31'`);
      expect(r.data.static.calendar_days_remaining).toBe(10);
      expect(r.data.overall).toBe('degraded');
      expect(r.data.notes.join('\n')).toMatch(/calendar ends on 2026-10-30 \(10 days left\)/);
    });

    it('is down when no realtime feed has ever been received, or the snapshot cannot be read', async () => {
      reset();
      const r = await h.q.getFeedStatus({});
      expect(r.data.overall).toBe('down');
      expect(r.freshness.status).toBe('unavailable');
      h.rt.failing = true;
      expect((await h.q.getFeedStatus({})).data.overall).toBe('down');
    });

    it('stays degraded, not down, while at least one realtime feed works', async () => {
      reset();
      h.rt.snapshot = snapshotOf({}, { vehicle_positions: feed(NOW - 10 * SEC) });
      expect((await h.q.getFeedStatus({})).data.overall).toBe('degraded');
    });
  });
});
