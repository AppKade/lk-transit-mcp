import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@lkt/core';
import { AFTER_MIDNIGHT, NOW, ROUTE_UUID, feed, harness, setupDb, snapshotOf, stu, tripUpdate } from './seed.js';
import type { Harness } from './seed.js';

const MIN = 60_000;
const ARGS = { within_minutes: 60, limit: 20 };

describe('getArrivals', () => {
  let db: Db & { close(): Promise<void> };
  let h: Harness;
  beforeAll(async () => {
    db = await setupDb({ extras: true });
    h = harness(db);
  }, 60_000);
  afterAll(async () => { await db.close(); });
  const reset = (ms = NOW) => { h.clock.set(ms); h.rt.snapshot = snapshotOf({}); h.rt.failing = false; };
  const byRoute = <T extends { route: { short_name: string | null } }>(rows: T[], name: string): T[] => rows.filter((r) => r.route.short_name === name);

  describe('schedule only', () => {
    it('lists the 06:30 departures at Pettah, sorted, with the static envelope', async () => {
      reset();
      const r = await h.q.getArrivals({ stop_id: '22', ...ARGS });
      expect(r.data.map((a) => a.route.short_name).sort()).toEqual(['CM01', 'CM02', 'CM08']);
      for (const a of r.data) {
        expect(a).toMatchObject({
          prediction_type: 'scheduled', scheduled_time: '2026-10-20T06:30:00+05:30', estimated_time: '2026-10-20T06:30:00+05:30',
          delay_seconds: null, minutes_until: 5, live_age_seconds: null, vehicle_id: null, direction_id: 1,
        });
        expect(a.trip_id).toMatch(/^lmt:trip:TRIP_CM0[128]_D1_T1$/);
      }
      expect(r.source).toMatchObject({ type: 'gtfs_static', url_ref: ['lmt.gtfs'] });
      expect(r.freshness.status).toBe('unavailable'); // trip_updates feed has never succeeded
    });

    it('accepts canonical and bare stop ids and any route id form, and rejects unknown routes', async () => {
      reset();
      const bare = await h.q.getArrivals({ stop_id: '22', ...ARGS });
      const canonical = await h.q.getArrivals({ stop_id: 'lmt:stop:22', ...ARGS });
      expect(canonical.data).toEqual(bare.data);
      for (const route_id of ['CM01', 'cm01', ROUTE_UUID.CM01, `lmt:route:${ROUTE_UUID.CM01}`]) {
        const r = await h.q.getArrivals({ stop_id: '22', route_id, ...ARGS });
        expect(r.data.map((a) => a.route.short_name)).toEqual(['CM01']);
      }
      await expect(h.q.getArrivals({ stop_id: '22', route_id: 'CM99', ...ARGS })).rejects.toMatchObject({ code: 'unknown_route' });
    });

    it('follows the explicit window and limit; minutes_until is floored and never negative', async () => {
      reset();
      expect((await h.q.getArrivals({ stop_id: '22', within_minutes: 4, limit: 20 })).data).toEqual([]);
      expect((await h.q.getArrivals({ stop_id: '22', within_minutes: 5, limit: 20 })).data).toHaveLength(3);
      expect((await h.q.getArrivals({ stop_id: '22', ...ARGS, limit: 2 })).data).toHaveLength(2);
      reset(NOW + 30_000); // 06:25:30 -> 4.5 minutes to go
      expect((await h.q.getArrivals({ stop_id: '22', ...ARGS })).data[0]!.minutes_until).toBe(4);
      reset(NOW + 5 * MIN); // exactly 06:30: departing now
      expect((await h.q.getArrivals({ stop_id: '22', ...ARGS })).data[0]!.minutes_until).toBe(0);
      reset(NOW + 5 * MIN + 1000); // already left
      expect((await h.q.getArrivals({ stop_id: '22', within_minutes: 1, limit: 20 })).data).toEqual([]);
    });

    it('works when the realtime source throws, labelling everything scheduled', async () => {
      reset();
      h.rt.failing = true;
      const r = await h.q.getArrivals({ stop_id: '22', ...ARGS });
      expect(r.data.length).toBeGreaterThan(0);
      expect(r.data.every((a) => a.prediction_type === 'scheduled')).toBe(true);
      expect(r.freshness.status).toBe('unavailable');
    });

    it('reports fresh static freshness when the live feed is healthy but has nothing for this stop', async () => {
      reset();
      h.rt.snapshot = snapshotOf({}, { trip_updates: feed(NOW - 5000) });
      const r = await h.q.getArrivals({ stop_id: '22', ...ARGS });
      expect(r.freshness.status).toBe('fresh');
      expect(r.source.type).toBe('gtfs_static');
      expect(r.data.every((a) => a.prediction_type === 'scheduled' && a.live_age_seconds === null)).toBe(true);
    });
  });

  describe('service days', () => {
    it('shows after-midnight (24:10) trips of the previous service day just after midnight', async () => {
      reset(AFTER_MIDNIGHT); // 2026-10-21 00:05
      const r = await h.q.getArrivals({ stop_id: '1', within_minutes: 30, limit: 20 });
      expect(r.data).toHaveLength(1);
      expect(r.data[0]).toMatchObject({
        trip_id: 'lmt:trip:TRIP_CM01_NIGHT', scheduled_time: '2026-10-21T00:10:00+05:30', minutes_until: 5, prediction_type: 'scheduled',
      });
    });

    it('also finds it from before midnight, in the same service day', async () => {
      reset(Date.UTC(2026, 9, 20, 18, 25, 0)); // 23:55
      const r = await h.q.getArrivals({ stop_id: '1', within_minutes: 30, limit: 20 });
      expect(r.data.map((a) => a.estimated_time)).toEqual(['2026-10-21T00:10:00+05:30']);
    });

    it('applies calendar_dates additions (type 1) and removals (type 2)', async () => {
      reset(Date.UTC(2026, 9, 20, 3, 20, 0)); // 08:50, Tuesday: the special service is added for this date only
      const added = await h.q.getArrivals({ stop_id: '1', within_minutes: 30, limit: 20 });
      expect(added.data.map((a) => a.trip_id)).toEqual(['lmt:trip:TRIP_CM01_SPECIAL']);
      reset(Date.UTC(2026, 9, 21, 3, 20, 0)); // next day: nothing special
      expect((await h.q.getArrivals({ stop_id: '1', within_minutes: 30, limit: 20 })).data).toEqual([]);
      reset(Date.UTC(2026, 9, 22, 0, 55, 0)); // 06:25 on the holiday: the daily service is removed
      expect((await h.q.getArrivals({ stop_id: '1', within_minutes: 60, limit: 20 })).data).toEqual([]);
      reset(Date.UTC(2026, 9, 21, 0, 55, 0)); // 06:25 the day before it runs
      const before = await h.q.getArrivals({ stop_id: '1', within_minutes: 60, limit: 20 });
      expect(before.data.map((a) => a.trip_id)).toContain('lmt:trip:TRIP_CM01_D0_T1');
    });
  });

  describe('with fresh live updates', () => {
    const cm01 = ROUTE_UUID.CM01;
    const cm02 = ROUTE_UUID.CM02;
    function live() {
      h.rt.snapshot = snapshotOf(
        {
          tripUpdates: [
            // CM01 towards Makumbura runs 4 minutes late at Pettah: same service as the 06:30 timetable row.
            tripUpdate({ id: 'a', route: cm01, dir: 1, observed: NOW - 10_000, vehicle: 'BUS-7', updates: [stu('22', NOW + 9 * MIN, 240), stu('23', NOW + 12 * MIN, 240)] }),
            // CM02 at 06:50 is nowhere near its 06:30 timetable row: a live-only row.
            tripUpdate({ id: 'b', route: cm02, dir: 1, observed: NOW - 5_000, vehicle: 'BUS-9', updates: [stu('22', NOW + 25 * MIN, 0)] }),
            // Unresolved route and other stops must be ignored.
            tripUpdate({ id: 'c', route: null, dir: null, observed: NOW - 5_000, updates: [stu('22', NOW + 8 * MIN, 0)] }),
            tripUpdate({ id: 'd', route: cm01, dir: 1, observed: NOW - 5_000, updates: [stu('30', NOW + 8 * MIN, 0)] }),
          ],
        },
        { trip_updates: feed(NOW - 10_000) },
      );
    }

    it('turns a matching timetable row into provider_live without duplicating it', async () => {
      reset();
      live();
      const r = await h.q.getArrivals({ stop_id: '22', ...ARGS });
      const cm01Rows = byRoute(r.data, 'CM01');
      expect(cm01Rows).toHaveLength(1);
      expect(cm01Rows[0]).toMatchObject({
        prediction_type: 'provider_live', estimated_time: '2026-10-20T06:34:00+05:30', scheduled_time: '2026-10-20T06:30:00+05:30',
        delay_seconds: 240, vehicle_id: 'lmt:vehicle:BUS-7', minutes_until: 9, live_age_seconds: 10, trip_id: 'lmt:trip:TRIP_CM01_D1_T1',
        direction_id: 1,
      });
    });

    it('keeps unmatched live rows (no scheduled_time) and unmatched timetable rows, sorted by estimate', async () => {
      reset();
      live();
      const r = await h.q.getArrivals({ stop_id: '22', ...ARGS });
      expect(r.data).toHaveLength(4);
      const cm02 = byRoute(r.data, 'CM02').sort((a, b) => a.estimated_time.localeCompare(b.estimated_time));
      expect(cm02[0]).toMatchObject({ prediction_type: 'scheduled', scheduled_time: '2026-10-20T06:30:00+05:30' });
      expect(cm02[1]).toMatchObject({
        prediction_type: 'provider_live', scheduled_time: null, trip_id: null, delay_seconds: 0, headsign: 'Millenium City via CM02',
      });
      expect(byRoute(r.data, 'CM08')[0]!.prediction_type).toBe('scheduled');
      const times = r.data.map((a) => Date.parse(a.estimated_time));
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(r.data.some((a) => a.prediction_type === 'derived_live')).toBe(false);
    });

    it('reports a mixed source and the trip_updates freshness', async () => {
      reset();
      live();
      const r = await h.q.getArrivals({ stop_id: '22', ...ARGS });
      expect(r.source).toMatchObject({ type: 'mixed', url_ref: ['lmt.gtfs', 'lmt.trip_updates'] });
      expect(r.freshness).toEqual({ status: 'fresh', age_seconds: 10, threshold_seconds: 90 });
    });

    it('applies the route filter and the window to live rows', async () => {
      reset();
      live();
      const only = await h.q.getArrivals({ stop_id: '22', route_id: 'CM02', ...ARGS });
      expect(only.data.every((a) => a.route.short_name === 'CM02')).toBe(true);
      const short = await h.q.getArrivals({ stop_id: '22', within_minutes: 10, limit: 20 });
      expect(short.data.map((a) => a.estimated_time)).not.toContain('2026-10-20T06:50:00+05:30');
    });

    it('a live-only answer is gtfs_realtime', async () => {
      reset(NOW + 20 * MIN);
      // 06:45 -> 07:05 window: only the live CM02 06:50 row exists (no timetable departures at stop 22).
      h.rt.snapshot = snapshotOf(
        { tripUpdates: [tripUpdate({ id: 'b', route: ROUTE_UUID.CM02, dir: 1, observed: NOW + 20 * MIN - 5_000, updates: [stu('22', NOW + 25 * MIN, 0)] })] },
        { trip_updates: feed(NOW + 20 * MIN - 5_000) },
      );
      const r = await h.q.getArrivals({ stop_id: '22', within_minutes: 20, limit: 20 });
      expect(r.data.map((a) => a.prediction_type)).toEqual(['provider_live']);
      expect(r.source.type).toBe('gtfs_realtime');
    });

    it('skips cancelled trips and skipped stops', async () => {
      reset();
      live();
      const snap = h.rt.snapshot;
      snap.tripUpdates[0]!.schedule_relationship = 'CANCELED';
      snap.tripUpdates[1]!.stop_time_updates[0]!.schedule_relationship = 'SKIPPED';
      const r = await h.q.getArrivals({ stop_id: '22', ...ARGS });
      expect(r.data.every((a) => a.prediction_type === 'scheduled')).toBe(true);
      expect(r.data).toHaveLength(3);
    });
  });

  describe('with stale live data', () => {
    const cm01 = ROUTE_UUID.CM01;
    const cm02 = ROUTE_UUID.CM02;
    const updates = (observed: number) => [
      tripUpdate({ id: 'a', route: cm01, dir: 1, observed, vehicle: 'BUS-7', updates: [stu('22', NOW + 9 * MIN, 240)] }),
      tripUpdate({ id: 'b', route: cm02, dir: 1, observed, vehicle: 'BUS-9', updates: [stu('22', NOW + 25 * MIN, 0)] }),
    ];

    it('never presents an old feed as provider_live', async () => {
      reset();
      h.rt.snapshot = snapshotOf({ tripUpdates: updates(NOW - 300_000) }, { trip_updates: feed(NOW - 300_000) });
      const r = await h.q.getArrivals({ stop_id: '22', ...ARGS });
      expect(r.data.some((a) => a.prediction_type === 'provider_live')).toBe(false);
      const matched = byRoute(r.data, 'CM01')[0]!;
      expect(matched).toMatchObject({
        prediction_type: 'stale', scheduled_time: '2026-10-20T06:30:00+05:30', estimated_time: '2026-10-20T06:30:00+05:30',
        delay_seconds: null, live_age_seconds: 300,
      });
      const lone = byRoute(r.data, 'CM02').find((a) => a.scheduled_time === null)!;
      expect(lone).toMatchObject({ prediction_type: 'stale', estimated_time: '2026-10-20T06:50:00+05:30', live_age_seconds: 300 });
      const plain = byRoute(r.data, 'CM08')[0]!;
      expect(plain).toMatchObject({ prediction_type: 'scheduled', live_age_seconds: 300 });
      expect(r.freshness).toEqual({ status: 'stale', age_seconds: 300, threshold_seconds: 90 });
      expect(r.source).toMatchObject({ type: 'gtfs_static', url_ref: ['lmt.gtfs', 'lmt.trip_updates'] });
    });

    it('treats an entity older than 90 s as stale even when the feed header is fresh', async () => {
      reset();
      h.rt.snapshot = snapshotOf({ tripUpdates: updates(NOW - 200_000) }, { trip_updates: feed(NOW - 5_000) });
      const r = await h.q.getArrivals({ stop_id: '22', ...ARGS });
      expect(r.data.some((a) => a.prediction_type === 'provider_live')).toBe(false);
      expect(byRoute(r.data, 'CM01')[0]).toMatchObject({ prediction_type: 'stale', live_age_seconds: 200 });
    });

    it('goes back to live as soon as the feed recovers', async () => {
      reset();
      h.rt.snapshot = snapshotOf({ tripUpdates: updates(NOW - 5_000) }, { trip_updates: feed(NOW - 5_000) });
      const r = await h.q.getArrivals({ stop_id: '22', ...ARGS });
      expect(byRoute(r.data, 'CM01')[0]!.prediction_type).toBe('provider_live');
    });
  });
});
