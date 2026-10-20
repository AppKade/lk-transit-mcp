import { LMT, ToolError, makeEnvelope, makeSource, type Envelope, type Freshness } from '@lkt/core';
import type { Journey, TransitQueries } from '@lkt/query';
import { vi } from 'vitest';
import { createApp } from '../src/app.js';
import { defineConfig, type AppConfig } from '../src/config.js';
import { createJsonLogger } from '../src/logger.js';
import type { RateLimiter } from '../src/rate-limit.js';

export const NOW = Date.parse('2026-10-20T04:45:12Z');
export const FRESH: Freshness = { status: 'fresh', age_seconds: 12, threshold_seconds: 90 };
const RT = makeSource('gtfs_realtime', ['lmt.vehicle_positions'], '2026-10-20T03:00Z-ab12cd', LMT.license);
const ST = makeSource('gtfs_static', ['lmt.gtfs'], '2026-10-20T03:00Z-ab12cd', LMT.license);

export const env = <T>(data: T, source = RT, freshness = FRESH): Envelope<T> => makeEnvelope('lmt', NOW, freshness, source, data);

const route = { route_id: 'lmt:route:cm01', short_name: 'CM01', long_name: 'Colombo - Makumbura' };

/** Hand-written stand-in for the query layer. Special ids trigger failures. */
export function fakeQueries(): TransitQueries & { [K in keyof TransitQueries]: ReturnType<typeof vi.fn> } {
  const guardStop = (id: string) => {
    if (id === 'lmt:stop:missing') throw new ToolError('unknown_stop', 'No stop "lmt:stop:missing". Use find_stops_nearby to get valid ids.');
    if (id === 'lmt:stop:down') throw new ToolError('provider_unavailable', 'Realtime hub unreachable at https://internal.example/hub?token=abc');
    if (id === 'lmt:stop:boom') {
      const e = new Error('SELECT * FROM stops WHERE lat=6.92714 failed at https://neon.internal/db');
      e.stack = 'Error: secret\n    at /srv/app/db.ts:10:5';
      throw e;
    }
  };
  const q = {
    listProviders: vi.fn(async () => [{ provider: 'lmt', name: LMT.name, timezone: LMT.timezone, license: LMT.license }]),
    findStopsNearby: vi.fn(async (_i) => env([{ stop_id: 'lmt:stop:22', name: 'Makumbura', code: null, latitude: 6.8421, longitude: 79.9712, distance_m: 120.4, routes: [route] }], ST)),
    getArrivals: vi.fn(async (i) => {
      guardStop(i.stop_id);
      return env([
        { route, direction_id: 0, headsign: 'Colombo', trip_id: 'lmt:trip:1', vehicle_id: 'v7', scheduled_time: '2026-10-20T10:20:00+05:30', estimated_time: '2026-10-20T10:22:00+05:30', delay_seconds: 120, minutes_until: 7, prediction_type: 'provider_live', live_age_seconds: 12 },
        { route, direction_id: 0, headsign: 'Colombo', trip_id: 'lmt:trip:2', vehicle_id: null, scheduled_time: '2026-10-20T10:50:00+05:30', estimated_time: '2026-10-20T10:50:00+05:30', delay_seconds: null, minutes_until: 35, prediction_type: 'scheduled', live_age_seconds: null },
      ]);
    }),
    getVehiclePositions: vi.fn(async () => env([{ vehicle_id: 'v7', label: 'NB-1234', route, direction_id: 0, latitude: 6.9012, longitude: 79.8765, bearing: 90, speed_kmh: 22, observed_at: '2026-10-20T10:14:58+05:30', age_seconds: 14, freshness: 'fresh', occupancy_status: null, occupancy_percentage: null, provider_trip_ref: 'LMT_CM01_0_X' }])),
    searchRoutes: vi.fn(async () => env([{ ...route, route_type: 3, color: null, text_color: null, headsigns: ['Colombo'] }], ST)),
    getRoute: vi.fn(async (i) => {
      if (i.route_id === 'lmt:route:missing') throw new ToolError('unknown_route', 'No route "lmt:route:missing".');
      return env({ route: { ...route, route_type: 3, color: null, text_color: null, headsigns: ['Colombo'] }, directions: [{ direction_id: 0, headsign: 'Colombo', stops: [{ stop_id: 'lmt:stop:22', name: 'Makumbura', sequence: 1, latitude: 6.84, longitude: 79.97 }], first_departure: '2026-10-20T05:00:00+05:30', last_departure: '2026-10-20T21:00:00+05:30', trips_per_day: 40 }], runs_today: true }, ST);
    }),
    getServiceAlerts: vi.fn(async () => env([], RT, { status: 'fresh', age_seconds: 30, threshold_seconds: 600 })),
    getFeedStatus: vi.fn(async (i) => {
      if (i.provider && i.provider !== 'lmt') throw new ToolError('unknown_provider', `Unknown provider "${i.provider}"`);
      const feed = { ok: true, last_success: '2026-10-20T10:15:00+05:30', header_age_seconds: 12, freshness: 'fresh' as const, entity_count: 9, quarantined_count: 0, consecutive_failures: 0 };
      return env({ provider: 'lmt', name: LMT.name, static: { active_feed_version: '2026-10-20T03:00Z-ab12cd', activated_at: null, calendar_end: '2026-12-31', calendar_days_remaining: 72, counts: { stops: 10 } }, realtime: { vehicle_positions: feed, trip_updates: feed, alerts: feed }, quality: { vehicle_orphan_ratio: 0, trip_update_orphan_ratio: 0 }, overall: 'healthy' as const, notes: [] });
    }),
    planTrip: vi.fn(async (i) => {
      if (i.origin.stop_id === 'lmt:stop:missing') throw new ToolError('unknown_stop', 'No stop "lmt:stop:missing".');
      const j: Journey = { departs: '2026-10-20T10:30:00+05:30', arrives: '2026-10-20T11:10:00+05:30', duration_minutes: 40, transfers: 0, legs: [{ mode: 'bus', route, headsign: 'Colombo', from_stop: { stop_id: 'lmt:stop:22', name: 'Makumbura' }, to_stop: { stop_id: 'lmt:stop:30', name: 'Fort' }, departs: '2026-10-20T10:30:00+05:30', arrives: '2026-10-20T11:10:00+05:30', prediction_type: 'scheduled' }], assumptions: ['Walking speed 4.8 km/h'] };
      return env([j], ST);
    }),
  };
  return q as never;
}

export interface Harness {
  app: ReturnType<typeof createApp>;
  queries: ReturnType<typeof fakeQueries>;
  logs: string[];
  req: (path: string, init?: RequestInit) => Promise<Response>;
}

export function harness(config: Partial<AppConfig> = {}, extra: { limiter?: RateLimiter; queries?: ReturnType<typeof fakeQueries> } = {}): Harness {
  const queries = extra.queries ?? fakeQueries();
  const logs: string[] = [];
  const app = createApp({
    queries,
    clock: { now: () => NOW },
    config: defineConfig(config),
    log: createJsonLogger((l) => logs.push(l)),
    ...(extra.limiter ? { limiter: extra.limiter } : {}),
  });
  return { app, queries, logs, req: (path, init) => Promise.resolve(app.request(`http://localhost${path}`, init)) };
}
