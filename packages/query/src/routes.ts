import { ToolError, formatGtfsTime, makeId } from '@lkt/core';
import type { Envelope, GetRouteInput, ProviderConfig, SearchRoutesInput } from '@lkt/core';
import { compareRoutes, findRoute, routeRef } from './catalog.js';
import type { Catalog, RouteRow } from './catalog.js';
import { envelopeOf, staticFreshness, staticKey } from './envelope.js';
import type { ActiveFeed, QueryEnv } from './env.js';
import { pickProvider, sourceId } from './refs.js';
import { activeServices } from './schedule.js';
import type { RouteDetail, RouteDirection, RouteStop, RouteSummary } from './types.js';

function summary(cfg: ProviderConfig, catalog: Catalog, r: RouteRow): RouteSummary {
  return {
    ...routeRef(cfg, r),
    route_type: r.route_type,
    color: r.color,
    text_color: r.text_color,
    headsigns: catalog.headsigns.get(r.route_id) ?? [],
  };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function searchRoutes(env: QueryEnv, input: SearchRoutesInput): Promise<Envelope<RouteSummary[]>> {
  const cfg = pickProvider(env.ctx, input.provider);
  const feed = await env.requireFeed(cfg);
  const catalog = await env.catalog(cfg, feed);
  const q = input.query.trim().toLowerCase();
  if (q.length === 0) throw new ToolError('invalid_argument', 'query must not be blank.');

  const stopMatches = await env.ctx.db.query<{ route_id: string }>(
    `SELECT DISTINCT t.route_id
       FROM stops s
       JOIN stop_times st ON st.feed_version_id = s.feed_version_id AND st.stop_id = s.stop_id
       JOIN trips t ON t.feed_version_id = st.feed_version_id AND t.trip_id = st.trip_id
      WHERE s.feed_version_id = $1 AND lower(s.name) LIKE $2 ESCAPE '\\'`,
    [feed.id, `%${escapeLike(q)}%`],
  );
  const viaStop = new Set(stopMatches.rows.map((r) => r.route_id));

  const ranked: { rank: number; route: RouteRow }[] = [];
  for (const route of catalog.routes.values()) {
    const short = route.short_name?.toLowerCase() ?? '';
    const long = route.long_name?.toLowerCase() ?? '';
    let rank = -1;
    if (short === q) rank = 0;
    else if (short.startsWith(q)) rank = 1;
    else if (short.includes(q)) rank = 2;
    else if (long.startsWith(q)) rank = 3;
    else if (long.includes(q)) rank = 4;
    else if (viaStop.has(route.route_id)) rank = 5;
    if (rank >= 0) ranked.push({ rank, route });
  }
  ranked.sort((a, b) => a.rank - b.rank || compareRoutes(a.route, b.route));

  const data = ranked.slice(0, input.limit ?? 10).map((x) => summary(cfg, catalog, x.route));
  const now = env.now();
  return envelopeOf(cfg, now, feed, 'gtfs_static', [staticKey(cfg)], staticFreshness(feed, now, env.today()), data);
}

interface TripAgg {
  trip_id: string;
  service_id: string;
  direction_id: number | null;
  headsign: string | null;
  n_stops: number;
  first_sec: number | null;
}

export async function getRoute(env: QueryEnv, input: GetRouteInput): Promise<Envelope<RouteDetail>> {
  const cfg = pickProvider(env.ctx, undefined, [input.route_id]);
  const feed = await env.requireFeed(cfg);
  const catalog = await env.catalog(cfg, feed);
  const route = findRoute(catalog, sourceId(cfg, input.route_id, 'route'));
  if (!route) throw new ToolError('unknown_route', `Unknown route '${input.route_id}'.`, { route_id: input.route_id });

  const now = env.now();
  const today = env.today();
  const todays = new Set(activeServices(catalog.calendar, today));

  const detail = await loadDetail(env, cfg, feed, route, input.direction_id, todays);
  const data: RouteDetail = {
    route: summary(cfg, catalog, route),
    directions: detail.directions,
    runs_today: detail.runsToday,
  };
  return envelopeOf(cfg, now, feed, 'gtfs_static', [staticKey(cfg)], staticFreshness(feed, now, today), data);
}

async function loadDetail(
  env: QueryEnv,
  cfg: ProviderConfig,
  feed: ActiveFeed,
  route: RouteRow,
  directionId: number | undefined,
  todays: Set<string>,
): Promise<{ directions: RouteDirection[]; runsToday: boolean }> {
  const params: unknown[] = [feed.id, route.route_id];
  if (directionId !== undefined) params.push(directionId);
  const trips = await env.ctx.db.query<TripAgg>(
    `SELECT t.trip_id, t.service_id, t.direction_id, t.headsign, COUNT(st.stop_sequence)::int AS n_stops,
            (ARRAY_AGG(COALESCE(st.departure_sec, st.arrival_sec) ORDER BY st.stop_sequence))[1] AS first_sec
       FROM trips t
       LEFT JOIN stop_times st ON st.feed_version_id = t.feed_version_id AND st.trip_id = t.trip_id
      WHERE t.feed_version_id = $1 AND t.route_id = $2${directionId === undefined ? '' : ' AND t.direction_id = $3'}
      GROUP BY t.trip_id, t.service_id, t.direction_id, t.headsign`,
    params,
  );

  const groups = new Map<number | null, TripAgg[]>();
  for (const t of trips.rows) groups.set(t.direction_id, [...(groups.get(t.direction_id) ?? []), t]);
  const runsToday = trips.rows.some((t) => todays.has(t.service_id));

  const patterns = [...groups.values()].map((g) => [...g].sort((a, b) => b.n_stops - a.n_stops || a.trip_id.localeCompare(b.trip_id))[0]);
  const patternIds = patterns.flatMap((p) => (p ? [p.trip_id] : []));
  const stopsByTrip = new Map<string, RouteStop[]>();
  if (patternIds.length > 0) {
    const stops = await env.ctx.db.query<{ trip_id: string; stop_sequence: number; stop_id: string; name: string; lat: number; lon: number }>(
      `SELECT st.trip_id, st.stop_sequence, s.stop_id, s.name, s.lat, s.lon
         FROM stop_times st
         JOIN stops s ON s.feed_version_id = st.feed_version_id AND s.stop_id = st.stop_id
        WHERE st.feed_version_id = $1 AND st.trip_id = ANY($2::text[])
        ORDER BY st.trip_id, st.stop_sequence`,
      [feed.id, patternIds],
    );
    for (const s of stops.rows) {
      const list = stopsByTrip.get(s.trip_id) ?? [];
      list.push({ stop_id: makeId(cfg.id, 'stop', s.stop_id), name: s.name, sequence: s.stop_sequence, latitude: s.lat, longitude: s.lon });
      stopsByTrip.set(s.trip_id, list);
    }
  }

  const directions: RouteDirection[] = [];
  for (const [dir, group] of groups) {
    const pattern = patterns.find((p) => p?.direction_id === dir);
    if (!pattern) continue;
    // Timetable span: today's trips when the route runs today, otherwise all trips of the direction.
    const running = group.filter((t) => todays.has(t.service_id));
    const times = (running.length > 0 ? running : group).flatMap((t) => (t.first_sec === null ? [] : [Number(t.first_sec)]));
    directions.push({
      direction_id: dir,
      headsign: pattern.headsign,
      stops: stopsByTrip.get(pattern.trip_id) ?? [],
      first_departure: times.length > 0 ? formatGtfsTime(Math.min(...times)) : null,
      last_departure: times.length > 0 ? formatGtfsTime(Math.max(...times)) : null,
      trips_per_day: running.length,
    });
  }
  directions.sort((a, b) => (a.direction_id ?? 99) - (b.direction_id ?? 99));
  return { directions, runsToday };
}
