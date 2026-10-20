import { boundingBox, haversineMeters, makeId } from '@lkt/core';
import type { Envelope, FindStopsNearbyInput } from '@lkt/core';
import { compareRoutes, routeRef } from './catalog.js';
import type { RouteRow } from './catalog.js';
import { envelopeOf, staticFreshness, staticKey } from './envelope.js';
import type { QueryEnv } from './env.js';
import { pickProvider } from './refs.js';
import type { StopNearby } from './types.js';

interface StopGeo {
  stop_id: string;
  name: string;
  code: string | null;
  lat: number;
  lon: number;
}

/** Coordinates are used for this query only: they are never logged, cached or persisted. */
export async function findStopsNearby(env: QueryEnv, input: FindStopsNearbyInput): Promise<Envelope<StopNearby[]>> {
  const cfg = pickProvider(env.ctx, input.provider);
  const feed = await env.requireFeed(cfg);
  const radius = input.radius_m ?? 800;
  const limit = input.limit ?? 10;

  const [west, south, east, north] = boundingBox(input.latitude, input.longitude, radius);
  const box = await env.ctx.db.query<StopGeo>(
    `SELECT stop_id, name, code, lat, lon FROM stops
      WHERE feed_version_id = $1 AND location_type = 0
        AND lat BETWEEN $2 AND $3 AND lon BETWEEN $4 AND $5`,
    [feed.id, south, north, west, east],
  );

  const nearest = box.rows
    .map((s) => ({ s, distance: haversineMeters(input.latitude, input.longitude, s.lat, s.lon) }))
    .filter((x) => x.distance <= radius)
    .sort((a, b) => a.distance - b.distance || a.s.stop_id.localeCompare(b.s.stop_id))
    .slice(0, limit);

  const routesByStop = new Map<string, Set<string>>();
  if (nearest.length > 0) {
    const served = await env.ctx.db.query<{ stop_id: string; route_id: string }>(
      `SELECT DISTINCT st.stop_id, t.route_id
         FROM stop_times st
         JOIN trips t ON t.feed_version_id = st.feed_version_id AND t.trip_id = st.trip_id
        WHERE st.feed_version_id = $1 AND st.stop_id = ANY($2::text[])`,
      [feed.id, nearest.map((x) => x.s.stop_id)],
    );
    for (const r of served.rows) {
      const set = routesByStop.get(r.stop_id) ?? new Set<string>();
      set.add(r.route_id);
      routesByStop.set(r.stop_id, set);
    }
  }

  const catalog = await env.catalog(cfg, feed);
  const data: StopNearby[] = nearest.map(({ s, distance }) => {
    const routes = [...(routesByStop.get(s.stop_id) ?? [])]
      .map((id) => catalog.routes.get(id))
      .filter((r): r is RouteRow => r !== undefined)
      .sort(compareRoutes)
      .map((r) => routeRef(cfg, r));
    return {
      stop_id: makeId(cfg.id, 'stop', s.stop_id),
      name: s.name,
      code: s.code,
      latitude: s.lat,
      longitude: s.lon,
      distance_m: Math.round(distance),
      routes,
    };
  });

  const now = env.now();
  return envelopeOf(cfg, now, feed, 'gtfs_static', [staticKey(cfg)], staticFreshness(feed, now, env.today()), data);
}
