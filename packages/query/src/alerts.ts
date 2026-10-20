import { THRESHOLDS, ToolError, computeFreshness, makeId, toColomboIso } from '@lkt/core';
import type { Envelope, GetServiceAlertsInput, RtAlert } from '@lkt/core';
import { findRoute } from './catalog.js';
import type { Catalog } from './catalog.js';
import { envelopeOf, realtimeKey } from './envelope.js';
import type { QueryEnv } from './env.js';
import { pickProvider, sourceId } from './refs.js';
import type { AlertOut } from './types.js';

const isActive = (a: RtAlert, now: number): boolean =>
  a.active_periods.length === 0 ||
  a.active_periods.some((p) => (p.start_ms === null || p.start_ms <= now) && (p.end_ms === null || now < p.end_ms));

export async function getServiceAlerts(env: QueryEnv, input: GetServiceAlertsInput): Promise<Envelope<AlertOut[]>> {
  const cfg = pickProvider(env.ctx, input.provider, [input.route_id, input.stop_id]);
  const feed = await env.requireFeed(cfg);
  const catalog = await env.catalog(cfg, feed);

  let routeFilter: string | undefined;
  if (input.route_id !== undefined) {
    const route = findRoute(catalog, sourceId(cfg, input.route_id, 'route'));
    if (!route) throw new ToolError('unknown_route', `Unknown route '${input.route_id}'.`, { route_id: input.route_id });
    routeFilter = route.route_id;
  }
  let stopFilter: string | undefined;
  if (input.stop_id !== undefined) {
    const stop = await env.stop(cfg, feed, sourceId(cfg, input.stop_id, 'stop'));
    if (!stop) throw new ToolError('unknown_stop', `Unknown stop '${input.stop_id}'.`, { stop_id: input.stop_id });
    stopFilter = stop.stop_id;
  }

  const now = env.now();
  const snapshot = await env.snapshot(cfg);
  // Realtime route ids may be static ids or short names; both resolve to the static route id when known.
  const resolveRoute = (raw: string) => findRoute(catalog, raw)?.route_id ?? raw;

  const data: AlertOut[] = [];
  for (const a of snapshot.alerts) {
    if (!isActive(a, now)) continue;
    if ((routeFilter !== undefined || stopFilter !== undefined) && !relevant(a, catalog, routeFilter, stopFilter)) continue;
    const routes = unique(a.informed_entities.flatMap((e) => (e.route_id ? [resolveRoute(e.route_id)] : [])));
    const stops = unique(a.informed_entities.flatMap((e) => (e.stop_id ? [e.stop_id] : [])));
    const periods = a.active_periods;
    data.push({
      alert_id: makeId(cfg.id, 'alert', a.entity_id),
      cause: a.cause,
      effect: a.effect,
      header: a.header,
      description: a.description,
      url: a.url,
      routes: routes.map((r) => (catalog.routes.has(r) ? makeId(cfg.id, 'route', r) : r)),
      stops: stops.map((s) => makeId(cfg.id, 'stop', s)),
      active_from: isoOrNull(periods.length === 0 ? null : minOf(periods.map((p) => p.start_ms))),
      active_until: isoOrNull(periods.length === 0 ? null : maxOf(periods.map((p) => p.end_ms))),
    });
  }

  const freshness = computeFreshness(snapshot.feeds.alerts.header_timestamp_ms, now, THRESHOLDS.alertSeconds);
  return envelopeOf(cfg, now, feed, 'gtfs_realtime', [realtimeKey(cfg, 'alerts')], freshness, data);
}

/** An alert matches a route/stop filter via its selectors; network-wide alerts (agency only) match everything. */
function relevant(a: RtAlert, catalog: Catalog, routeId: string | undefined, stopId: string | undefined): boolean {
  return a.informed_entities.some((e) => {
    if (!e.route_id && !e.stop_id && !e.trip_id) return true;
    if (routeId !== undefined && e.route_id && findRoute(catalog, e.route_id)?.route_id === routeId) return true;
    return stopId !== undefined && e.stop_id === stopId;
  });
}

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : toColomboIso(ms));
/** Earliest start; an open start (null) anywhere means "from the beginning". */
const minOf = (xs: (number | null)[]): number | null => (xs.includes(null) ? null : Math.min(...(xs as number[])));
/** Latest end; an open end (null) anywhere means "until further notice". */
const maxOf = (xs: (number | null)[]): number | null => (xs.includes(null) ? null : Math.max(...(xs as number[])));
