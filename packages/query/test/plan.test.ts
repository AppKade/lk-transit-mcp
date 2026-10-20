import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db, PlanTripInput } from '@lkt/core';
import type { Journey } from '../src/index.js';
import { AFTER_MIDNIGHT, NOW, ROUTE_UUID, feed, harness, setupDb, snapshotOf, stu, tripUpdate } from './seed.js';
import type { Harness } from './seed.js';

const MIN = 60_000;
const CM05 = 'c0050000-0000-4000-8000-000000000005';
const at = (hhmm: string, date = '2026-10-20') => Date.parse(`${date}T${hhmm}+05:30`);
type Place = PlanTripInput['origin'];
const stop = (stop_id: string): Place => ({ stop_id });

describe('planTrip', () => {
  let db: Db & { close(): Promise<void> };
  let h: Harness;
  beforeAll(async () => {
    db = await setupDb({ extras: true });
    h = harness(db);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  const reset = (ms = NOW) => { h.clock.set(ms); h.rt.snapshot = snapshotOf({}); h.rt.failing = false; };
  const plan = (origin: Place, destination: Place, o: Partial<PlanTripInput> = {}) =>
    h.q.planTrip({ origin, destination, max_transfers: 1, wheelchair_accessible: false, ...o });
  const busLegs = (j: Journey) => j.legs.filter((l) => l.mode === 'bus');
  const sig = (j: Journey) =>
    j.legs.map((l) => `${l.mode === 'bus' ? l.route?.short_name : 'walk'} ${l.from_stop.stop_id.split(':').pop()}>${l.to_stop.stop_id.split(':').pop()} ${l.departs.slice(11, 16)}-${l.arrives.slice(11, 16)}`);

  describe('direct journeys', () => {
    it('finds the CM01 run between two of its stops, with canonical ids, names and the static envelope', async () => {
      reset();
      const r = await plan(stop('22'), stop('lmt:stop:41'), { max_transfers: 0 });
      expect(r.data).toHaveLength(1);
      const j = r.data[0]!;
      expect(j).toMatchObject({ departs: '2026-10-20T06:30:00+05:30', arrives: '2026-10-20T07:27:00+05:30', duration_minutes: 57, transfers: 0 });
      expect(busLegs(j)).toHaveLength(1);
      expect(j.legs[0]).toMatchObject({
        mode: 'bus', headsign: 'Makumbura via CM01', prediction_type: 'scheduled',
        route: { route_id: `lmt:route:${ROUTE_UUID.CM01}`, short_name: 'CM01' },
        from_stop: { stop_id: 'lmt:stop:22', name: 'Pettah' }, to_stop: { stop_id: 'lmt:stop:41', name: 'Makumbura' },
        departs: '2026-10-20T06:30:00+05:30', arrives: '2026-10-20T07:27:00+05:30',
      });
      expect(r.provider).toBe('lmt');
      expect(r.source).toMatchObject({ type: 'gtfs_static', url_ref: ['lmt.gtfs'] });
      expect(r.freshness.status).toBe('unavailable'); // trip_updates feed has never succeeded
      expect(j.assumptions.join(' ')).toMatch(/1\.2 m\/s/);
      expect(j.assumptions.join(' ')).toMatch(/Timetable-based; live delay applied only where a fresh provider update exists/);
    });

    it('boards a run departing exactly at the requested time but never one that already left', async () => {
      reset();
      const exact = await plan(stop('22'), stop('41'), { departure_time: '2026-10-20T06:30:00+05:30' });
      expect(exact.data[0]!.departs).toBe('2026-10-20T06:30:00+05:30');
      const late = await plan(stop('22'), stop('41'), { departure_time: '2026-10-20T06:30:01+05:30' });
      expect(late.data).toEqual([]); // the next CM01 run (10:00) is outside the 3-hour horizon
    });

    it('defaults the departure to the injected clock', async () => {
      reset(at('09:45'));
      const r = await plan(stop('22'), stop('41'));
      expect(r.data[0]).toMatchObject({ departs: '2026-10-20T10:00:00+05:30', arrives: '2026-10-20T10:57:00+05:30' });
      expect(r.as_of).toBe('2026-10-20T09:45:00+05:30');
    });
  });

  describe('transfers', () => {
    it('returns a Pareto set: a one-transfer option that arrives earlier next to the direct one, fastest first', async () => {
      reset();
      const r = await plan(stop('1'), stop('22'), { max_transfers: 1 });
      expect(r.data.map((j) => j.transfers)).toEqual([1, 0]);
      const [fast, direct] = r.data as [Journey, Journey];
      expect(sig(fast)).toEqual(['CM03 1>72 06:30-06:57', 'CM08 72>21 07:00-07:21', 'walk 21>22 07:21-07:21']);
      expect(fast.arrives).toMatch(/^2026-10-20T07:21:/); // last bus at 07:21, then the short walk
      expect(sig(direct)).toEqual(['CM01 1>21 06:30-07:30', 'walk 21>22 07:30-07:30']);
      expect(Date.parse(fast.arrives)).toBeLessThan(Date.parse(direct.arrives));
      expect(fast.legs[2]).toMatchObject({ mode: 'walk', walk_meters: expect.any(Number) });
      expect(fast.legs[2]!.walk_meters!).toBeLessThanOrEqual(250);
    });

    it('max_transfers 0 returns only direct journeys', async () => {
      reset();
      const r = await plan(stop('1'), stop('22'), { max_transfers: 0 });
      expect(r.data).toHaveLength(1);
      expect(r.data[0]!.transfers).toBe(0);
      expect(busLegs(r.data[0]!)).toHaveLength(1);
      expect((await plan(stop('134'), stop('83'), { max_transfers: 0 })).data).toEqual([]);
    });

    it('changes at a shared stop (>= 120 s) and walks the last 250 m explicitly', async () => {
      reset();
      const r = await plan(stop('134'), stop('83'));
      expect(r.data).toHaveLength(1);
      const j = r.data[0]!;
      expect(sig(j)).toEqual(['CM05 134>52 06:30-06:48', 'CM03 52>82 07:06-07:30', 'walk 82>83 07:30-07:30']);
      expect(j.transfers).toBe(1);
      expect(busLegs(j).every((l) => l.route && l.headsign)).toBe(true);
      expect(j.legs[2]).toMatchObject({ mode: 'walk', from_stop: { name: expect.any(String) }, to_stop: { stop_id: 'lmt:stop:83' } });
      expect(j.legs[2]!.prediction_type).toBeUndefined();
      expect(j.assumptions.join(' ')).toMatch(/at least 120 s/);
      expect(j.assumptions.join(' ')).toMatch(/250 m add 60 s/);
    });

    it('walks between two different stops to change bus, with the 60 s buffer', async () => {
      reset();
      const r = await plan(stop('22'), stop('100'));
      const j = r.data[0]!;
      expect(sig(j)).toEqual(['CM02 22>61 06:30-06:48', 'walk 61>118 06:48-06:49', 'CM04 118>100 07:35-08:50']);
      expect(j.transfers).toBe(1);
      const walk = j.legs[1]!;
      expect(walk.walk_meters).toBeGreaterThan(0);
      expect(Date.parse(j.legs[2]!.departs) - Date.parse(walk.arrives)).toBeGreaterThanOrEqual(60_000);
    });

    it('respects the max_transfers cap on bus legs and never repeats a stop', async () => {
      reset();
      for (const [o, d] of [['22', '100'], ['1', '22'], ['134', '83'], ['22', '1'], ['100', '41']] as const) {
        const r = await plan(stop(o), stop(d), { max_transfers: 2 });
        expect(r.data.length).toBeLessThanOrEqual(3);
        for (const j of r.data) {
          expect(busLegs(j).length).toBeLessThanOrEqual(3);
          expect(j.transfers).toBe(busLegs(j).length - 1);
          const stops = [j.legs[0]!.from_stop.stop_id, ...j.legs.map((l) => l.to_stop.stop_id)];
          expect(new Set(stops).size).toBe(stops.length);
          for (let i = 1; i < j.legs.length; i++) expect(Date.parse(j.legs[i]!.departs)).toBeGreaterThanOrEqual(Date.parse(j.legs[i - 1]!.arrives));
        }
        for (let i = 1; i < r.data.length; i++) {
          expect(Date.parse(r.data[i]!.arrives)).toBeGreaterThanOrEqual(Date.parse(r.data[i - 1]!.arrives));
          expect(r.data[i]!.transfers).toBeLessThan(r.data[i - 1]!.transfers);
        }
      }
    });

    it('reports duration from first departure to last arrival', async () => {
      reset();
      const j = (await plan(stop('134'), stop('83'))).data[0]!;
      expect(j.duration_minutes).toBe(60);
    });
  });

  describe('coordinates', () => {
    // ~100 m north of Pettah (22) and ~110 m east of Makumbura (41)
    const near22 = { latitude: 6.93444 + 0.0009, longitude: 79.85492 };
    const near41 = { latitude: 6.84051, longitude: 79.97562 + 0.001 };

    it('adds explicit access and egress walks at 1.2 m/s and states the assumption', async () => {
      reset();
      const r = await plan(near22, near41, { max_transfers: 0 });
      const j = r.data[0]!;
      const [access, ...rest] = j.legs;
      const egress = rest[rest.length - 1]!;
      expect(access).toMatchObject({ mode: 'walk', from_stop: { stop_id: 'origin' } });
      expect(access!.walk_meters!).toBeGreaterThan(60);
      expect(access!.walk_meters!).toBeLessThan(160);
      expect(egress).toMatchObject({ mode: 'walk', to_stop: { stop_id: 'destination' } });
      expect(egress.walk_meters!).toBeGreaterThan(60);
      const walkSeconds = (l: { departs: string; arrives: string }) => (Date.parse(l.arrives) - Date.parse(l.departs)) / 1000;
      expect(walkSeconds(access!)).toBe(Math.ceil(access!.walk_meters! / 1.2));
      expect(Math.abs(walkSeconds(egress) - egress.walk_meters! / 1.2)).toBeLessThan(2);
      // the access walk ends before the bus leaves and starts no earlier than the requested departure
      expect(Date.parse(access!.arrives)).toBeLessThanOrEqual(Date.parse(rest[0]!.departs));
      expect(Date.parse(access!.departs)).toBeGreaterThanOrEqual(NOW);
      expect(Date.parse(j.arrives)).toBe(Date.parse(egress.arrives));
      expect(j.assumptions.join(' ')).toMatch(/closest stops within 600 m and are not stored/);
    });

    it('accepts a stop on one side and coordinates on the other', async () => {
      reset();
      const r = await plan(stop('22'), near41, { max_transfers: 0 });
      expect(r.data[0]!.legs[0]!.mode).toBe('bus');
      expect(r.data[0]!.legs.at(-1)).toMatchObject({ mode: 'walk', to_stop: { stop_id: 'destination' } });
    });

    it('is not an error when no stop is near; explains in notes', async () => {
      reset();
      const r = (await plan({ latitude: 0, longitude: 0 }, stop('22'))) as { data: unknown[]; notes?: string[] };
      expect(r.data).toEqual([]);
      expect(r.notes?.join(' ')).toMatch(/No served stop within 600 m of the origin/);
    });

    it('does not log coordinates', async () => {
      reset();
      const seen: string[] = [];
      const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
      for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => { seen.push(a.join(' ')); };
      try { await plan(near22, near41); } finally { Object.assign(console, orig); }
      expect(seen).toEqual([]);
    });
  });

  describe('time horizon and service days', () => {
    it('returns [] with an explanation after the last trip of the day', async () => {
      reset();
      const r = (await plan(stop('22'), stop('41'), { departure_time: '2026-10-20T21:00:00+05:30' })) as { data: unknown[]; notes?: string[] };
      expect(r.data).toEqual([]);
      expect(r.notes?.join(' ')).toMatch(/No journey with at most 1 transfer\(s\) found for boardings between 21:00 and 00:00/);
      expect(r.notes?.join(' ')).toMatch(/Timetable-based/);
    });

    it('does not look beyond three hours', async () => {
      reset();
      expect((await plan(stop('22'), stop('41'), { departure_time: '2026-10-20T06:31:00+05:30' })).data).toEqual([]);
      expect((await plan(stop('22'), stop('41'), { departure_time: '2026-10-20T07:00:00+05:30' })).data[0]!.departs).toBe('2026-10-20T10:00:00+05:30');
    });

    it('finds the after-midnight run of the previous service day and the next calendar day within the horizon', async () => {
      reset();
      const late = await plan(stop('1'), stop('3'), { departure_time: '2026-10-20T23:30:00+05:30', max_transfers: 0 });
      expect(late.data).toHaveLength(1);
      expect(late.data[0]!.legs[0]).toMatchObject({ departs: '2026-10-21T00:10:00+05:30', arrives: '2026-10-21T00:16:00+05:30', headsign: 'Night owl' });
      reset(AFTER_MIDNIGHT);
      const now = await plan(stop('1'), stop('3'), { max_transfers: 0 });
      expect(now.data[0]!.legs[0]!.departs).toBe('2026-10-21T00:10:00+05:30');
    });

    it('says so when a holiday leaves no service', async () => {
      reset();
      const r = (await plan(stop('22'), stop('41'), { departure_time: '2026-10-22T06:00:00+05:30' })) as { data: unknown[]; notes?: string[] };
      expect(r.data).toEqual([]);
      expect(r.notes?.join(' ')).toMatch(/No scheduled service/);
    });

    it('uses one-day special service additions', async () => {
      reset();
      const r = await plan(stop('1'), stop('2'), { departure_time: '2026-10-20T09:00:00+05:30', max_transfers: 0 });
      expect(r.data[0]!.legs[0]).toMatchObject({ headsign: 'Special', departs: '2026-10-20T09:05:00+05:30' });
    });
  });

  describe('live overlay', () => {
    const cm01 = ROUTE_UUID.CM01;
    const withFeed = (updates: ReturnType<typeof tripUpdate>[], headerMs = NOW - 5_000) => {
      h.rt.snapshot = snapshotOf({ tripUpdates: updates }, { trip_updates: feed(headerMs) });
    };

    it('shifts a fresh run to the provider times and marks the leg provider_live', async () => {
      reset();
      withFeed([tripUpdate({ id: 'a', route: cm01, dir: 1, observed: NOW - 5_000, vehicle: 'BUS-7', updates: [stu('22', at('06:35'), 300), stu('30', at('06:57'), 180)] })]);
      const r = await plan(stop('22'), stop('41'), { max_transfers: 0 });
      const leg = r.data[0]!.legs[0]!;
      expect(leg).toMatchObject({ prediction_type: 'provider_live', departs: '2026-10-20T06:35:00+05:30' });
      // stop 30 is scheduled at 06:54, so the delay becomes 3 min there and carries on to stop 41 (07:27 -> 07:30)
      expect(leg.arrives).toBe('2026-10-20T07:30:00+05:30');
      expect(r.freshness.status).toBe('fresh');
      expect(r.source).toMatchObject({ type: 'mixed', url_ref: ['lmt.gtfs', 'lmt.trip_updates'] });
      expect(r.data[0]!.assumptions.join(' ')).toMatch(/1 of 1 bus leg\(s\) use fresh provider live predictions/);
    });

    it('lets a delayed arrival break a connection that the timetable allows, and honours the 120 s change time', async () => {
      reset();
      // CM05 reaches stop 52 at 06:48 and CM03 leaves it at 07:06
      const lateAt = (t: string, delay: number) =>
        tripUpdate({ id: 'c', route: CM05, dir: 0, observed: NOW - 5_000, updates: [stu('52', at(t), delay)] });
      withFeed([lateAt('07:03:30', 930)]); // ready 07:05:30 -> still catches 07:06
      expect((await plan(stop('134'), stop('83'))).data[0]!.legs.map((l) => l.prediction_type)).toEqual(['provider_live', 'scheduled', undefined]);
      withFeed([lateAt('07:04:30', 990)]); // ready 07:06:30 -> misses it; the next CM03 is outside the horizon
      expect((await plan(stop('134'), stop('83'))).data).toEqual([]);
    });

    it('ignores cancelled updates, unresolved routes and predictions far from any timetable run', async () => {
      reset();
      const bad = tripUpdate({ id: 'x', route: cm01, dir: 1, observed: NOW - 5_000, updates: [stu('22', at('08:00'), 0)] });
      withFeed([bad, tripUpdate({ id: 'y', route: null, dir: null, observed: NOW - 5_000, updates: [stu('22', at('06:40'), 0)] }), { ...tripUpdate({ id: 'z', route: cm01, dir: 1, observed: NOW - 5_000, updates: [stu('22', at('06:40'), 0)] }), schedule_relationship: 'CANCELED' }]);
      const r = await plan(stop('22'), stop('41'), { max_transfers: 0 });
      expect(r.data[0]!.legs[0]).toMatchObject({ prediction_type: 'scheduled', departs: '2026-10-20T06:30:00+05:30' });
      expect(r.source.type).toBe('gtfs_static');
      expect(r.freshness.status).toBe('fresh'); // healthy live feed that is not in the answer: static note
    });

    it('falls back to the timetable and says so when the live feed is stale', async () => {
      reset();
      withFeed([tripUpdate({ id: 'a', route: cm01, dir: 1, observed: NOW - 300_000, updates: [stu('22', at('06:35'), 300)] })], NOW - 300_000);
      const r = await plan(stop('22'), stop('41'), { max_transfers: 0 });
      expect(r.data[0]!.legs[0]).toMatchObject({ prediction_type: 'scheduled', departs: '2026-10-20T06:30:00+05:30', arrives: '2026-10-20T07:27:00+05:30' });
      expect(r.freshness).toMatchObject({ status: 'stale', age_seconds: 300 });
      expect(r.source).toMatchObject({ type: 'gtfs_static', url_ref: ['lmt.gtfs', 'lmt.trip_updates'] });
      expect(r.data[0]!.assumptions.join(' ')).toMatch(/stale \(300 s old\)/);
    });

    it('treats a fresh feed header with an old entity as scheduled, and survives a broken realtime source', async () => {
      reset();
      withFeed([tripUpdate({ id: 'a', route: cm01, dir: 1, observed: NOW - 200_000, updates: [stu('22', at('06:35'), 300)] })]);
      expect((await plan(stop('22'), stop('41'), { max_transfers: 0 })).data[0]!.legs[0]!.prediction_type).toBe('scheduled');
      h.rt.failing = true;
      const r = await plan(stop('22'), stop('41'), { max_transfers: 0 });
      expect(r.data[0]!.legs[0]!.prediction_type).toBe('scheduled');
      expect(r.freshness.status).toBe('unavailable');
    });

    it('never labels a leg derived_live', async () => {
      reset();
      withFeed([tripUpdate({ id: 'a', route: cm01, dir: 1, observed: NOW - 5_000, updates: [stu('22', at('06:35'), 300)] })]);
      const r = await plan(stop('1'), stop('22'), { max_transfers: 2 });
      for (const l of r.data.flatMap((j) => j.legs)) expect(l.prediction_type).not.toBe('derived_live');
    });
  });

  describe('errors and edge cases', () => {
    it('rejects unknown stops with unknown_stop', async () => {
      reset();
      await expect(plan(stop('99999'), stop('22'))).rejects.toMatchObject({ code: 'unknown_stop' });
      await expect(plan(stop('22'), stop('lmt:stop:nope'))).rejects.toMatchObject({ code: 'unknown_stop' });
    });

    it('rejects the same origin and destination with invalid_argument', async () => {
      reset();
      await expect(plan(stop('22'), stop('lmt:stop:22'))).rejects.toMatchObject({ code: 'invalid_argument' });
      await expect(plan({ latitude: 6.9, longitude: 79.85 }, { latitude: 6.9, longitude: 79.85 })).rejects.toMatchObject({ code: 'invalid_argument' });
    });

    it('rejects ids of another provider or type', async () => {
      reset();
      await expect(plan(stop('zzz:stop:1'), stop('22'))).rejects.toMatchObject({ code: 'unknown_provider' });
      await expect(plan(stop('lmt:route:abc'), stop('22'))).rejects.toMatchObject({ code: 'invalid_argument' });
    });

    it('is empty (not an error) between stops that no trip connects', async () => {
      reset();
      const r = (await plan(stop('42'), stop('83'), { max_transfers: 2 })) as { data: unknown[]; notes?: string[] };
      expect(r.data).toEqual([]);
      expect(r.notes?.length).toBeGreaterThan(0);
    });

    it('is deterministic and fast when warm', async () => {
      reset();
      const a = await plan(stop('1'), stop('22'), { max_transfers: 2 });
      const t0 = performance.now();
      const b = await plan(stop('1'), stop('22'), { max_transfers: 2 });
      expect(performance.now() - t0).toBeLessThan(50);
      expect(b).toEqual(a);
    });
  });

  describe('wheelchair requests', () => {
    it('states that accessibility is unknown when the feed has no data, without filtering or claiming it', async () => {
      reset();
      const r = await plan(stop('22'), stop('41'), { wheelchair_accessible: true, max_transfers: 0 });
      expect(r.data).toHaveLength(1);
      const text = r.data[0]!.assumptions.join(' ');
      expect(text).toMatch(/accessibility is unknown/);
      expect(text).toMatch(/no accessibility is claimed/);
      expect((await plan(stop('22'), stop('41'), { max_transfers: 0 })).data[0]!.assumptions.join(' ')).not.toMatch(/ccessib/);
    });

    it('uses only flagged trips when the feed marks some as accessible', async () => {
      const db2 = await setupDb({ extras: true });
      try {
        await db2.query(`UPDATE trips SET wheelchair_accessible = 1 WHERE trip_id = 'TRIP_CM01_D1_T2'`);
        await db2.query(`UPDATE trips SET wheelchair_accessible = 2 WHERE trip_id = 'TRIP_CM01_D1_T1'`);
        const h2 = harness(db2);
        const ask = (wheelchair_accessible: boolean) =>
          h2.q.planTrip({ origin: stop('22'), destination: stop('41'), max_transfers: 0, wheelchair_accessible, departure_time: '2026-10-20T06:25:00+05:30' });
        expect((await ask(false)).data[0]!.departs).toBe('2026-10-20T06:30:00+05:30');
        expect((await ask(true)).data).toEqual([]); // the only flagged run leaves at 10:00, beyond the horizon
        const later = await h2.q.planTrip({ origin: stop('22'), destination: stop('41'), max_transfers: 0, wheelchair_accessible: true, departure_time: '2026-10-20T09:30:00+05:30' });
        expect(later.data[0]!.departs).toBe('2026-10-20T10:00:00+05:30');
        expect(later.data[0]!.assumptions.join(' ')).toMatch(/flags as wheelchair accessible/);
      } finally {
        await db2.close();
      }
    }, 60_000);
  });
});
