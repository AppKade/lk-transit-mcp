import { makeId } from '@lkt/core';
import type { Db, ProviderConfig } from '@lkt/core';
import type { ServiceCalendar } from './schedule.js';
import type { RouteRef } from './types.js';

export interface RouteRow {
  route_id: string;
  short_name: string | null;
  long_name: string | null;
  route_type: number;
  color: string | null;
  text_color: string | null;
}

/** Per-feed-version lookup data that is small and read by almost every call. Cached by `env.catalog`. */
export interface Catalog {
  feedVersionId: number;
  routes: Map<string, RouteRow>;
  /** lower-cased short name -> route_id */
  byShortName: Map<string, string>;
  /** route_id -> distinct headsigns, most common first */
  headsigns: Map<string, string[]>;
  /** `${route_id}|${direction_id ?? ''}` -> most common headsign */
  directionHeadsign: Map<string, string>;
  calendar: ServiceCalendar;
}

export const directionKey = (routeId: string, directionId: number | null) => `${routeId}|${directionId ?? ''}`;

const DAY_COLUMNS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

export async function loadCatalog(db: Db, feedVersionId: number): Promise<Catalog> {
  const [routes, heads, cals, exc] = await Promise.all([
    db.query<RouteRow>(
      `SELECT route_id, short_name, long_name, route_type, color, text_color FROM routes WHERE feed_version_id = $1`,
      [feedVersionId],
    ),
    db.query<{ route_id: string; direction_id: number | null; headsign: string }>(
      `SELECT route_id, direction_id, headsign, COUNT(*)::int AS n FROM trips
       WHERE feed_version_id = $1 AND headsign IS NOT NULL
       GROUP BY route_id, direction_id, headsign ORDER BY n DESC, headsign`,
      [feedVersionId],
    ),
    db.query<Record<string, unknown>>(
      `SELECT service_id, ${DAY_COLUMNS.join(', ')}, start_date::text AS start_date, end_date::text AS end_date
       FROM calendars WHERE feed_version_id = $1`,
      [feedVersionId],
    ),
    db.query<{ service_id: string; date: string; exception_type: number }>(
      `SELECT service_id, date::text AS date, exception_type FROM calendar_dates WHERE feed_version_id = $1`,
      [feedVersionId],
    ),
  ]);

  const routeMap = new Map<string, RouteRow>();
  const byShortName = new Map<string, string>();
  for (const r of routes.rows) {
    routeMap.set(r.route_id, r);
    const key = r.short_name?.toLowerCase();
    if (key && !byShortName.has(key)) byShortName.set(key, r.route_id);
  }

  const headsigns = new Map<string, string[]>();
  const directionHeadsign = new Map<string, string>();
  for (const h of heads.rows) {
    const list = headsigns.get(h.route_id) ?? [];
    if (!list.includes(h.headsign)) list.push(h.headsign);
    headsigns.set(h.route_id, list);
    const k = directionKey(h.route_id, h.direction_id);
    if (!directionHeadsign.has(k)) directionHeadsign.set(k, h.headsign);
  }

  const calendars = cals.rows.map((c) => ({
    service_id: String(c['service_id']),
    days: DAY_COLUMNS.map((d) => c[d] === true),
    start: String(c['start_date']),
    end: String(c['end_date']),
  }));
  const exceptions: ServiceCalendar['exceptions'] = new Map();
  for (const e of exc.rows) {
    const day = exceptions.get(e.date) ?? new Map<string, number>();
    day.set(e.service_id, e.exception_type);
    exceptions.set(e.date, day);
  }

  return { feedVersionId, routes: routeMap, byShortName, headsigns, directionHeadsign, calendar: { calendars, exceptions } };
}

/** Resolves a source route id or a (case-insensitive) short name. Canonical prefixes must be stripped by the caller. */
export function findRoute(catalog: Catalog, token: string): RouteRow | null {
  const direct = catalog.routes.get(token);
  if (direct) return direct;
  const id = catalog.byShortName.get(token.trim().toLowerCase());
  return id ? (catalog.routes.get(id) ?? null) : null;
}

export function routeRef(cfg: ProviderConfig, row: RouteRow): RouteRef {
  return { route_id: makeId(cfg.id, 'route', row.route_id), short_name: row.short_name, long_name: row.long_name };
}

/** Natural ordering for short names (CM2 before CM10). */
export function compareRoutes(a: RouteRow, b: RouteRow): number {
  return (a.short_name ?? a.route_id).localeCompare(b.short_name ?? b.route_id, 'en', { numeric: true });
}
