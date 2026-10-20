import { THRESHOLDS, ToolError, computeFreshness, makeId, toColomboIso } from '@lkt/core';
import type { Envelope, GetVehiclePositionsInput, RtVehicle } from '@lkt/core';
import { findRoute, routeRef } from './catalog.js';
import { envelopeOf, realtimeKey } from './envelope.js';
import type { QueryEnv } from './env.js';
import { pickProvider, sourceId } from './refs.js';
import type { VehicleOut } from './types.js';

export async function getVehiclePositions(env: QueryEnv, input: GetVehiclePositionsInput): Promise<Envelope<VehicleOut[]>> {
  const cfg = pickProvider(env.ctx, input.provider, [input.route_id, input.trip_id]);
  const feed = await env.requireFeed(cfg);
  const catalog = await env.catalog(cfg, feed);

  let routeId: string | undefined;
  if (input.route_id !== undefined) {
    const route = findRoute(catalog, sourceId(cfg, input.route_id, 'route'));
    if (!route) throw new ToolError('unknown_route', `Unknown route '${input.route_id}'.`, { route_id: input.route_id });
    routeId = route.route_id;
  }
  const tripToken = input.trip_id === undefined ? undefined : sourceId(cfg, input.trip_id, 'trip');

  const now = env.now();
  const maxAge = input.max_age_seconds ?? THRESHOLDS.vehicleSeconds;
  const snapshot = await env.snapshot(cfg);

  const [west, south, east, north] = input.bbox ?? [-180, -90, 180, 90];
  const matches = (v: RtVehicle): boolean => {
    if ((now - v.observed_at_ms) / 1000 > maxAge) return false;
    if (routeId !== undefined && v.resolution.route_id !== routeId) return false;
    if (
      tripToken !== undefined &&
      v.trip_id !== tripToken &&
      v.trip_id !== input.trip_id &&
      v.resolution.static_trip_id !== tripToken
    ) {
      return false;
    }
    return v.longitude >= west && v.longitude <= east && v.latitude >= south && v.latitude <= north;
  };

  const data: VehicleOut[] = snapshot.vehicles.filter(matches).map((v) => {
    const age = Math.max(0, Math.round((now - v.observed_at_ms) / 1000));
    const route = v.resolution.route_id === null ? undefined : catalog.routes.get(v.resolution.route_id);
    return {
      vehicle_id: v.vehicle_id === null ? null : makeId(cfg.id, 'vehicle', v.vehicle_id),
      label: v.label,
      route: route ? routeRef(cfg, route) : null,
      direction_id: v.resolution.direction_id ?? v.direction_id,
      latitude: v.latitude,
      longitude: v.longitude,
      bearing: v.bearing,
      speed_kmh: v.speed_mps === null ? null : Math.round(v.speed_mps * 3.6 * 10) / 10,
      observed_at: toColomboIso(v.observed_at_ms),
      age_seconds: age,
      freshness: age <= THRESHOLDS.vehicleSeconds ? 'fresh' : 'stale',
      occupancy_status: v.occupancy_status,
      occupancy_percentage: v.occupancy_percentage,
      provider_trip_ref: v.trip_id,
    };
  });
  data.sort((a, b) => (a.vehicle_id ?? a.label ?? '').localeCompare(b.vehicle_id ?? b.label ?? ''));

  const freshness = computeFreshness(snapshot.feeds.vehicle_positions.header_timestamp_ms, now, THRESHOLDS.vehicleSeconds);
  return envelopeOf(cfg, now, feed, 'gtfs_realtime', [realtimeKey(cfg, 'vehicle_positions')], freshness, data);
}
