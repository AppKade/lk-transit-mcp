import type { Db, Resolution } from '@lkt/core';
import { parseTripId, unresolvedResolution } from '@lkt/gtfs';

export interface ActiveStaticFeed {
  id: string;
  label: string;
}

/** The provider's currently active static feed version, or null when none has been activated. */
export async function loadActiveStaticFeed(db: Db, providerId: string): Promise<ActiveStaticFeed | null> {
  const r = await db.query<{ id: string | number | bigint | null; label: string | null }>(
    `SELECT p.active_feed_version_id AS id, fv.label AS label
       FROM providers p LEFT JOIN feed_versions fv ON fv.id = p.active_feed_version_id
      WHERE p.id = $1`,
    [providerId],
  );
  const row = r.rows[0];
  if (!row || row.id === null || row.id === undefined) return null;
  return { id: String(row.id), label: row.label ?? String(row.id) };
}

export interface RtRef {
  tripId: string | null;
  routeRaw: string | null;
  direction: number | null;
}

interface StaticTrip {
  route_id: string;
  direction_id: number | null;
}

const MAX_TRIP_CACHE = 20_000;
const TRIP_BATCH = 500;

/**
 * Lookup over one static feed version. Routes are loaded whole (a handful per provider); trips are fetched on demand
 * for the realtime ids seen and cached, including misses, so the usual all-miss LMT case costs one query per new id.
 */
export class StaticIndex {
  private readonly routesById = new Set<string>();
  private readonly routesByShortName = new Map<string, string>();
  private readonly trips = new Map<string, StaticTrip | null>();

  private constructor(
    private readonly db: Db,
    readonly feedVersionId: string,
    readonly label: string,
  ) {}

  static async load(db: Db, feed: ActiveStaticFeed): Promise<StaticIndex> {
    const idx = new StaticIndex(db, feed.id, feed.label);
    const r = await db.query<{ route_id: string; short_name: string | null }>(
      'SELECT route_id, short_name FROM routes WHERE feed_version_id = $1 ORDER BY route_id',
      [feed.id],
    );
    for (const row of r.rows) {
      idx.routesById.add(row.route_id);
      const key = row.short_name?.trim().toLowerCase();
      // Deterministic if two routes share a short name: the lowest route_id wins.
      if (key && !idx.routesByShortName.has(key)) idx.routesByShortName.set(key, row.route_id);
    }
    return idx;
  }

  async prefetchTrips(tripIds: Iterable<string>): Promise<void> {
    const missing = [...new Set(tripIds)].filter((t) => !this.trips.has(t));
    if (missing.length === 0) return;
    if (this.trips.size + missing.length > MAX_TRIP_CACHE) this.trips.clear();
    for (let i = 0; i < missing.length; i += TRIP_BATCH) {
      const chunk = missing.slice(i, i + TRIP_BATCH);
      const r = await this.db.query<{ trip_id: string; route_id: string; direction_id: number | null }>(
        'SELECT trip_id, route_id, direction_id FROM trips WHERE feed_version_id = $1 AND trip_id = ANY($2::text[])',
        [this.feedVersionId, chunk],
      );
      for (const id of chunk) this.trips.set(id, null);
      for (const row of r.rows) {
        this.trips.set(row.trip_id, { route_id: row.route_id, direction_id: row.direction_id === null ? null : Number(row.direction_id) });
      }
    }
  }

  /** trip_id -> route_id -> route short name (+ direction), in that order of preference. */
  resolve(ref: RtRef): Resolution {
    const parsed = parseTripId(ref.tripId);
    const direction = ref.direction ?? parsed?.direction ?? null;

    const trip = ref.tripId ? this.trips.get(ref.tripId) : null;
    if (trip) {
      return { route_id: trip.route_id, direction_id: trip.direction_id ?? direction, static_trip_id: ref.tripId, method: 'trip_id' };
    }
    if (ref.routeRaw && this.routesById.has(ref.routeRaw)) {
      return { route_id: ref.routeRaw, direction_id: direction, static_trip_id: null, method: 'route_id' };
    }
    for (const candidate of [ref.routeRaw, parsed?.route]) {
      const routeId = candidate ? this.routesByShortName.get(candidate.trim().toLowerCase()) : undefined;
      if (routeId) return { route_id: routeId, direction_id: direction, static_trip_id: null, method: 'route_short_name' };
    }
    return { ...unresolvedResolution(), direction_id: direction };
  }
}
