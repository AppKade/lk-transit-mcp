import {
  THRESHOLDS,
  ToolError,
  addDays,
  colomboDate,
  computeFreshness,
  makeId,
  serviceDayStartMs,
  toColomboIso,
} from '@lkt/core';
import type { Envelope, GetArrivalsInput, PredictionType, ProviderConfig, RealtimeSnapshot } from '@lkt/core';
import { directionKey, findRoute, routeRef } from './catalog.js';
import type { Catalog, RouteRow } from './catalog.js';
import { envelopeOf, realtimeKey, staticFreshness, staticKey } from './envelope.js';
import type { ActiveFeed, QueryEnv } from './env.js';
import { pickProvider, sourceId } from './refs.js';
import { activeServices } from './schedule.js';
import type { Arrival } from './types.js';

/** A live prediction counts as the same service as a timetable row within |delay| + this many seconds. */
const MATCH_SLACK_S = 180;
/** Schedule rows and live predictions are fetched this far beyond the requested window so late/early buses still pair up. */
const CANDIDATE_MARGIN_MS = 30 * 60_000;
/** Service days can run past midnight; GTFS times up to this many hours after the service day start are considered. */
const MAX_SERVICE_HOURS = 36;

interface Sched {
  tripId: string;
  routeId: string;
  directionId: number | null;
  headsign: string | null;
  timeMs: number;
}

interface Live {
  routeId: string;
  directionId: number | null;
  timeMs: number;
  delayS: number | null;
  vehicleId: string | null;
  /** True only when both the feed header and this entity are within the freshness threshold. */
  fresh: boolean;
  ageS: number;
}

export async function getArrivals(env: QueryEnv, input: GetArrivalsInput): Promise<Envelope<Arrival[]>> {
  const cfg = pickProvider(env.ctx, input.provider, [input.stop_id, input.route_id]);
  const feed = await env.requireFeed(cfg);
  const stopToken = sourceId(cfg, input.stop_id, 'stop');
  const stop = await env.stop(cfg, feed, stopToken);
  if (!stop) throw new ToolError('unknown_stop', `Unknown stop '${input.stop_id}'.`, { stop_id: input.stop_id });

  const catalog = await env.catalog(cfg, feed);
  let route: RouteRow | undefined;
  if (input.route_id !== undefined) {
    route = findRoute(catalog, sourceId(cfg, input.route_id, 'route')) ?? undefined;
    if (!route) throw new ToolError('unknown_route', `Unknown route '${input.route_id}'.`, { route_id: input.route_id });
  }

  const now = env.now();
  const windowEnd = now + (input.within_minutes ?? 60) * 60_000;
  const loMs = now - CANDIDATE_MARGIN_MS;
  const hiMs = windowEnd + CANDIDATE_MARGIN_MS;

  const [scheds, snapshot] = await Promise.all([
    loadSchedule(env, feed, catalog, stop.stop_id, route?.route_id, loMs, hiMs),
    env.snapshot(cfg),
  ]);

  const tuFeed = computeFreshness(snapshot.feeds.trip_updates.header_timestamp_ms, now, THRESHOLDS.tripUpdateSeconds);
  const lives = collectLive(snapshot, stop.stop_id, route?.route_id, now, loMs, hiMs, tuFeed.status === 'fresh', tuFeed.age_seconds);
  const matches = matchLive(lives, scheds);

  const matchedScheds = new Set<Sched>(matches.values());
  const rows: Arrival[] = [];
  const build = (partial: Omit<Arrival, 'route' | 'minutes_until'> & { routeId: string }) => {
    const r = catalog.routes.get(partial.routeId);
    const { routeId, ...rest } = partial;
    const ref = r ? routeRef(cfg, r) : { route_id: makeId(cfg.id, 'route', routeId), short_name: null, long_name: null };
    const est = Date.parse(rest.estimated_time);
    rows.push({ ...rest, route: ref, minutes_until: Math.max(0, Math.floor((est - now) / 60_000)) });
  };

  // A late feed means the timetable rows carry the age of the feed they could not be upgraded from.
  const scheduleOnlyAge = tuFeed.status === 'stale' ? tuFeed.age_seconds : null;

  for (const live of lives) {
    const sched = matches.get(live);
    let type: PredictionType;
    let estimated: number;
    let delay: number | null;
    if (live.fresh) {
      type = 'provider_live';
      estimated = live.timeMs;
      delay = live.delayS ?? (sched ? Math.round((live.timeMs - sched.timeMs) / 1000) : null);
    } else if (sched) {
      // Never promote an old prediction: fall back to the timetable time and flag it.
      type = 'stale';
      estimated = sched.timeMs;
      delay = null;
    } else {
      type = 'stale';
      estimated = live.timeMs;
      delay = live.delayS;
    }
    if (estimated < now || estimated > windowEnd) continue;
    build({
      routeId: live.routeId,
      direction_id: live.directionId ?? sched?.directionId ?? null,
      headsign: sched?.headsign ?? catalog.directionHeadsign.get(directionKey(live.routeId, live.directionId)) ?? null,
      trip_id: sched ? makeId(cfg.id, 'trip', sched.tripId) : null,
      vehicle_id: live.vehicleId === null ? null : makeId(cfg.id, 'vehicle', live.vehicleId),
      scheduled_time: sched ? toColomboIso(sched.timeMs) : null,
      estimated_time: toColomboIso(estimated),
      delay_seconds: delay,
      prediction_type: type,
      live_age_seconds: live.ageS,
    });
  }

  for (const s of scheds) {
    if (matchedScheds.has(s) || s.timeMs < now || s.timeMs > windowEnd) continue;
    build({
      routeId: s.routeId,
      direction_id: s.directionId,
      headsign: s.headsign,
      trip_id: makeId(cfg.id, 'trip', s.tripId),
      vehicle_id: null,
      scheduled_time: toColomboIso(s.timeMs),
      estimated_time: toColomboIso(s.timeMs),
      delay_seconds: null,
      prediction_type: 'scheduled',
      live_age_seconds: scheduleOnlyAge,
    });
  }

  rows.sort((a, b) => Date.parse(a.estimated_time) - Date.parse(b.estimated_time) || a.route.route_id.localeCompare(b.route.route_id));
  const data = rows.slice(0, input.limit ?? 20);

  return envelope(cfg, feed, env, now, data, tuFeed);
}

function envelope(
  cfg: ProviderConfig,
  feed: ActiveFeed,
  env: QueryEnv,
  now: number,
  data: Arrival[],
  tuFeed: ReturnType<typeof computeFreshness>,
): Envelope<Arrival[]> {
  const liveRows = data.filter((r) => r.prediction_type === 'provider_live').length;
  const usedLiveFeed = liveRows > 0 || data.some((r) => r.prediction_type === 'stale') || tuFeed.status === 'stale';
  const hasSchedule = data.some((r) => r.scheduled_time !== null);
  const type = liveRows === 0 ? 'gtfs_static' : hasSchedule ? 'mixed' : 'gtfs_realtime';
  const urlRef = [staticKey(cfg), ...(usedLiveFeed ? [realtimeKey(cfg, 'trip_updates')] : [])];
  // A degraded live feed is always reported; a healthy one only when its data is actually in the answer.
  const freshness = tuFeed.status !== 'fresh' || liveRows > 0 ? tuFeed : staticFreshness(feed, now, env.today());
  return envelopeOf(cfg, now, feed, type, urlRef, freshness, data);
}

/** Timetable rows at one stop for every service day that can overlap [loMs, hiMs], in one round trip. */
async function loadSchedule(
  env: QueryEnv,
  feed: ActiveFeed,
  catalog: Catalog,
  stopId: string,
  routeId: string | undefined,
  loMs: number,
  hiMs: number,
): Promise<Sched[]> {
  const params: unknown[] = [feed.id, stopId];
  const parts: string[] = [];
  const days: { start: number }[] = [];

  let date = addDays(colomboDate(loMs), -1);
  const lastDate = colomboDate(hiMs);
  for (; date <= lastDate; date = addDays(date, 1)) {
    const start = serviceDayStartMs(date);
    if (loMs - start > MAX_SERVICE_HOURS * 3_600_000) continue;
    const services = activeServices(catalog.calendar, date);
    if (services.length === 0) continue;
    const secLo = Math.max(0, Math.floor((loMs - start) / 1000));
    const secHi = Math.floor((hiMs - start) / 1000);
    if (secHi < 0) continue;

    params.push(services, secLo, secHi);
    const [pSvc, pLo, pHi] = [params.length - 2, params.length - 1, params.length];
    let routeClause = '';
    if (routeId !== undefined) {
      params.push(routeId);
      routeClause = ` AND t.route_id = $${params.length}`;
    }
    parts.push(
      `SELECT ${days.length} AS di, t.trip_id, t.route_id, t.direction_id, t.headsign,
              COALESCE(st.departure_sec, st.arrival_sec) AS sec
         FROM stop_times st
         JOIN trips t ON t.feed_version_id = st.feed_version_id AND t.trip_id = st.trip_id
        WHERE st.feed_version_id = $1 AND st.stop_id = $2
          AND t.service_id = ANY($${pSvc}::text[])${routeClause}
          AND (st.departure_sec BETWEEN $${pLo} AND $${pHi}
               OR (st.departure_sec IS NULL AND st.arrival_sec BETWEEN $${pLo} AND $${pHi}))`,
    );
    days.push({ start });
  }
  if (parts.length === 0) return [];

  const r = await env.ctx.db.query<{
    di: number;
    trip_id: string;
    route_id: string;
    direction_id: number | null;
    headsign: string | null;
    sec: number;
  }>(parts.join('\nUNION ALL\n'), params);

  const out: Sched[] = [];
  for (const row of r.rows) {
    const day = days[Number(row.di)];
    if (!day) continue;
    out.push({
      tripId: row.trip_id,
      routeId: row.route_id,
      directionId: row.direction_id,
      headsign: row.headsign,
      timeMs: day.start + Number(row.sec) * 1000,
    });
  }
  return out;
}

/** Live predictions for this stop from resolved TripUpdates. Stale ones are kept (flagged) so they can be reported as such. */
function collectLive(
  snapshot: RealtimeSnapshot,
  stopId: string,
  routeId: string | undefined,
  now: number,
  loMs: number,
  hiMs: number,
  feedFresh: boolean,
  feedAgeS: number | null,
): Live[] {
  const out: Live[] = [];
  const seen = new Set<string>();
  for (const tu of snapshot.tripUpdates) {
    if (tu.schedule_relationship === 'CANCELED' || tu.schedule_relationship === 'DELETED') continue;
    const rid = tu.resolution.route_id;
    if (rid === null || (routeId !== undefined && rid !== routeId)) continue;
    const entityAge = Math.max(0, Math.round((now - tu.observed_at_ms) / 1000));
    const fresh = feedFresh && entityAge <= THRESHOLDS.tripUpdateSeconds;
    const ageS = fresh ? entityAge : Math.max(entityAge, feedAgeS ?? 0);
    for (const u of tu.stop_time_updates) {
      if (u.stop_id !== stopId || u.schedule_relationship === 'SKIPPED' || u.schedule_relationship === 'NO_DATA') continue;
      const timeMs = u.departure_time_ms ?? u.arrival_time_ms;
      if (timeMs === null || timeMs < loMs || timeMs > hiMs) continue;
      const key = `${rid}|${tu.vehicle_id ?? tu.entity_id}|${timeMs}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        routeId: rid,
        directionId: tu.resolution.direction_id ?? tu.direction_id,
        timeMs,
        delayS: u.departure_delay_s ?? u.arrival_delay_s,
        vehicleId: tu.vehicle_id,
        fresh,
        ageS,
      });
    }
  }
  return out;
}

/**
 * Pairs live predictions with timetable rows of the same route/direction (LMT realtime trip ids do not match static
 * trip ids). Closest pairs win; each timetable row is used at most once.
 */
function matchLive(lives: Live[], scheds: Sched[]): Map<Live, Sched> {
  const byRoute = new Map<string, Sched[]>();
  for (const s of scheds) byRoute.set(s.routeId, [...(byRoute.get(s.routeId) ?? []), s]);

  const pairs: { live: Live; sched: Sched; gap: number }[] = [];
  for (const live of lives) {
    const tolerance = Math.abs(live.delayS ?? 0) * 1000 + MATCH_SLACK_S * 1000;
    for (const sched of byRoute.get(live.routeId) ?? []) {
      if (live.directionId !== null && sched.directionId !== null && live.directionId !== sched.directionId) continue;
      const gap = Math.abs(sched.timeMs - live.timeMs);
      if (gap <= tolerance) pairs.push({ live, sched, gap });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap);

  const matches = new Map<Live, Sched>();
  const used = new Set<Sched>();
  for (const p of pairs) {
    if (matches.has(p.live) || used.has(p.sched)) continue;
    matches.set(p.live, p.sched);
    used.add(p.sched);
  }
  return matches;
}
