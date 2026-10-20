import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LMT, ToolError } from '@lkt/core';
import type { Db } from '@lkt/core';
import { createPgliteDb, migrate } from '@lkt/db';
import { FEED_LABEL, ROUTE_UUID, harness, setupDb } from './seed.js';
import type { Harness } from './seed.js';

const PETTAH = { latitude: 6.93444, longitude: 79.85492 };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ToolError) return e.code;
    throw e;
  }
  return 'no error';
}

describe('static lookups on the seeded LMT fixture', () => {
  let db: Db & { close(): Promise<void> };
  let h: Harness;
  beforeAll(async () => {
    db = await setupDb();
    h = harness(db);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it('lists providers with their licence block', async () => {
    const providers = await h.q.listProviders();
    expect(providers).toEqual([{ provider: 'lmt', name: 'Lanka Metro Transit', timezone: 'Asia/Colombo', license: LMT.license }]);
  });

  describe('findStopsNearby', () => {
    it('orders by distance around Pettah and lists the serving routes', async () => {
      const r = await h.q.findStopsNearby({ ...PETTAH, radius_m: 800, limit: 10 });
      expect(r.data[0]).toMatchObject({ stop_id: 'lmt:stop:22', name: 'Pettah', distance_m: 0 });
      expect(r.data[0]!.routes.map((x) => x.short_name)).toEqual(['CM01', 'CM02', 'CM08']);
      expect(r.data[0]!.routes[0]).toMatchObject({ route_id: `lmt:route:${ROUTE_UUID.CM01}` });
      const d = r.data.map((s) => s.distance_m);
      expect(d).toEqual([...d].sort((a, b) => a - b));
      expect(d.every((m) => m <= 800)).toBe(true);
      expect(r.data.map((s) => s.stop_id)).toContain('lmt:stop:21');
    });

    it('honours radius and limit', async () => {
      const tight = await h.q.findStopsNearby({ ...PETTAH, radius_m: 50, limit: 10 });
      expect(tight.data.map((s) => s.stop_id)).toEqual(['lmt:stop:22', 'lmt:stop:21']);
      const one = await h.q.findStopsNearby({ ...PETTAH, radius_m: 5000, limit: 1 });
      expect(one.data).toHaveLength(1);
      const wide = await h.q.findStopsNearby({ ...PETTAH, radius_m: 5000, limit: 50 });
      expect(wide.data.length).toBeGreaterThan(10);
    });

    it('returns an empty list far from the network, with a static envelope', async () => {
      const r = await h.q.findStopsNearby({ latitude: 7.29, longitude: 80.63, radius_m: 800, limit: 10 });
      expect(r.data).toEqual([]);
      expect(r.provider).toBe('lmt');
      expect(r.as_of).toBe('2026-10-20T06:25:00+05:30');
      expect(r.source).toMatchObject({ type: 'gtfs_static', url_ref: ['lmt.gtfs'], feed_version: FEED_LABEL, license: 'CC-BY-4.0' });
      expect(r.freshness.status).toBe('fresh');
    });
  });

  describe('searchRoutes', () => {
    it('ranks exact short name, then prefix, then name matches, case-insensitively', async () => {
      const exact = await h.q.searchRoutes({ query: 'cm01', limit: 10 });
      expect(exact.data.map((r) => r.short_name)).toEqual(['CM01']);
      const prefix = await h.q.searchRoutes({ query: 'CM0', limit: 10 });
      expect(prefix.data.map((r) => r.short_name)).toEqual(['CM01', 'CM02', 'CM03', 'CM04', 'CM05', 'CM06', 'CM08']);
      const long = await h.q.searchRoutes({ query: 'kollupitiya', limit: 10 });
      expect(long.data.map((r) => r.short_name)).toEqual(['CM06']);
    });

    it('matches names of stops on the route, after short and long name matches', async () => {
      const r = await h.q.searchRoutes({ query: 'pettah', limit: 10 });
      const names = r.data.map((x) => x.short_name);
      expect(names[0]).toBe('CM08'); // long name "CM08 (Kahathuduwa - Pettah)"
      expect(names).toEqual(expect.arrayContaining(['CM01', 'CM02'])); // reached through stop names
      expect(r.data[0]!.headsigns).toContain('Pettah via CM08');
    });

    it('applies the limit and treats LIKE wildcards literally', async () => {
      expect((await h.q.searchRoutes({ query: 'cm', limit: 2 })).data).toHaveLength(2);
      expect((await h.q.searchRoutes({ query: '%', limit: 10 })).data).toEqual([]);
      expect((await h.q.searchRoutes({ query: "x'; drop table routes;--", limit: 10 })).data).toEqual([]);
    });
  });

  describe('getRoute', () => {
    it('returns directions with the longest stop pattern, first/last departures and todays service', async () => {
      const r = await h.q.getRoute({ route_id: 'CM01' });
      expect(r.data.route).toMatchObject({ route_id: `lmt:route:${ROUTE_UUID.CM01}`, short_name: 'CM01', route_type: 3, color: '1A5A96' });
      expect(r.data.runs_today).toBe(true);
      expect(r.data.directions.map((d) => d.direction_id)).toEqual([0, 1]);
      const d0 = r.data.directions[0]!;
      expect(d0).toMatchObject({ first_departure: '06:30:00', last_departure: '18:45:00', trips_per_day: 4 });
      expect(d0.stops.length).toBeGreaterThan(15);
      expect(d0.stops[0]).toMatchObject({ stop_id: 'lmt:stop:1', sequence: 1 });
      const seq = d0.stops.map((s) => s.sequence);
      expect(seq).toEqual([...seq].sort((a, b) => a - b));
      expect(r.source.type).toBe('gtfs_static');
    });

    it('accepts uuid and canonical ids and filters by direction', async () => {
      const a = await h.q.getRoute({ route_id: ROUTE_UUID.CM01, direction_id: 1 });
      const b = await h.q.getRoute({ route_id: `lmt:route:${ROUTE_UUID.CM01}`, direction_id: 1 });
      expect(a.data.directions.map((d) => d.direction_id)).toEqual([1]);
      expect(b.data).toEqual(a.data);
    });
  });

  describe('errors', () => {
    it('unknown route / stop / provider', async () => {
      expect(await code(h.q.getRoute({ route_id: 'NOPE' }))).toBe('unknown_route');
      expect(await code(h.q.getArrivals({ stop_id: '999999', within_minutes: 30, limit: 5 }))).toBe('unknown_stop');
      expect(await code(h.q.searchRoutes({ query: 'cm', provider: 'sltb', limit: 5 }))).toBe('unknown_provider');
      expect(await code(h.q.getFeedStatus({ provider: 'sltb' }))).toBe('unknown_provider');
      expect(await code(h.q.getRoute({ route_id: 'sltb:route:1' }))).toBe('unknown_provider');
    });

    it('rejects ids of the wrong type or of another provider when the provider is explicit', async () => {
      expect(await code(h.q.getArrivals({ stop_id: 'lmt:route:5', within_minutes: 30, limit: 5 }))).toBe('invalid_argument');
      expect(await code(h.q.getArrivals({ stop_id: 'lmt:stop:22', provider: 'lmt', within_minutes: 30, limit: 5 }))).toBe('no error');
    });
  });
});

describe('provider without an active feed', () => {
  it('reports provider_unavailable (a staged feed is not served) but still answers feed status', async () => {
    const db = await createPgliteDb();
    await migrate(db);
    await db.query(`INSERT INTO providers (id, name, timezone) VALUES ('lmt', 'Lanka Metro Transit', 'Asia/Colombo')`);
    await db.query(`INSERT INTO feed_versions (provider_id, status, checksum, label, source_key) VALUES ('lmt', 'staged', 'x', 'staged-1', 'lmt.gtfs')`);
    const { q } = harness(db);
    expect(await code(q.findStopsNearby({ ...PETTAH, radius_m: 800, limit: 5 }))).toBe('provider_unavailable');
    expect(await code(q.getArrivals({ stop_id: '22', within_minutes: 30, limit: 5 }))).toBe('provider_unavailable');
    expect(await code(q.getRoute({ route_id: 'CM01' }))).toBe('provider_unavailable');
    const s = await q.getFeedStatus({});
    expect(s.data.overall).toBe('down');
    expect(s.data.static).toMatchObject({ active_feed_version: null, calendar_end: null, calendar_days_remaining: null });
    expect(s.data.notes.join(' ')).toMatch(/No active static feed/);
    expect(s.source.feed_version).toBeNull();
    await db.close();
  });
});
