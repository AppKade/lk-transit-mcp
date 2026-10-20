import { haversineMeters } from '@lkt/core';
import type { Db } from '@lkt/core';

/** Walking speed (4.3 km/h) for access, egress and stop-to-stop transfers. */
export const WALK_MPS = 1.2;
/** Stops within this straight-line distance are walkable transfers. */
export const TRANSFER_WALK_M = 250;
/** A bus-to-bus transfer at the same stop needs at least this long. */
export const MIN_TRANSFER_MS = 120_000;
/** Extra buffer when the transfer involves walking to another stop. */
export const WALK_BUFFER_MS = 60_000;

export const walkMs = (meters: number): number => Math.ceil(meters / WALK_MPS) * 1000;

export interface NetStop {
  idx: number;
  id: string;
  name: string;
  lat: number;
  lon: number;
}

/** One scheduled trip; times are seconds since its service day start (may exceed 86400). */
export interface NetTrip {
  tripId: string;
  routeId: string;
  directionId: number | null;
  headsign: string | null;
  serviceId: string;
  wheelchair: number | null;
  stops: number[];
  arr: number[];
  dep: number[];
  /** Whether passengers may board / alight at position i (pickup_type / drop_off_type 1 = no). */
  board: boolean[];
  alight: boolean[];
}

export interface Footpath {
  to: number;
  meters: number;
}

/** The whole timetable of one feed version, in memory. Small networks only (LMT: ~220 stops, ~55 trips). */
export interface Network {
  feedVersionId: number;
  stops: NetStop[];
  byId: Map<string, NetStop>;
  /** Stops visited by at least one trip. */
  served: boolean[];
  trips: NetTrip[];
  footpaths: Footpath[][];
  hasWheelchairData: boolean;
}

interface TimeRow {
  trip_id: string;
  stop_id: string;
  arrival_sec: number | null;
  departure_sec: number | null;
  pickup_type: number | null;
  drop_off_type: number | null;
}

export async function loadNetwork(db: Db, feedVersionId: number): Promise<Network> {
  const [stopRows, tripRows, timeRows] = await Promise.all([
    db.query<{ stop_id: string; name: string; lat: number; lon: number }>(
      `SELECT stop_id, name, lat, lon FROM stops WHERE feed_version_id = $1 ORDER BY stop_id`,
      [feedVersionId],
    ),
    db.query<{
      trip_id: string;
      route_id: string;
      service_id: string;
      headsign: string | null;
      direction_id: number | null;
      wheelchair_accessible: number | null;
    }>(
      `SELECT trip_id, route_id, service_id, headsign, direction_id, wheelchair_accessible
         FROM trips WHERE feed_version_id = $1 ORDER BY trip_id`,
      [feedVersionId],
    ),
    db.query<TimeRow>(
      `SELECT trip_id, stop_id, arrival_sec, departure_sec, pickup_type, drop_off_type
         FROM stop_times WHERE feed_version_id = $1 ORDER BY trip_id, stop_sequence`,
      [feedVersionId],
    ),
  ]);

  const stops: NetStop[] = stopRows.rows.map((s, idx) => ({ idx, id: s.stop_id, name: s.name, lat: Number(s.lat), lon: Number(s.lon) }));
  const byId = new Map(stops.map((s) => [s.id, s]));
  const served = stops.map(() => false);

  const rowsByTrip = new Map<string, TimeRow[]>();
  for (const r of timeRows.rows) {
    const list = rowsByTrip.get(r.trip_id);
    if (list) list.push(r);
    else rowsByTrip.set(r.trip_id, [r]);
  }

  const trips: NetTrip[] = [];
  for (const t of tripRows.rows) {
    const rows = (rowsByTrip.get(t.trip_id) ?? []).filter((r) => byId.has(r.stop_id));
    if (rows.length < 2) continue;
    const times = fillTimes(rows);
    if (!times) continue;
    const last = rows.length - 1;
    const trip: NetTrip = {
      tripId: t.trip_id,
      routeId: t.route_id,
      directionId: t.direction_id === null ? null : Number(t.direction_id),
      headsign: t.headsign,
      serviceId: t.service_id,
      wheelchair: t.wheelchair_accessible === null ? null : Number(t.wheelchair_accessible),
      stops: rows.map((r) => byId.get(r.stop_id)!.idx),
      arr: [],
      dep: [],
      board: rows.map((r, i) => i < last && r.pickup_type !== 1),
      alight: rows.map((r, i) => i > 0 && r.drop_off_type !== 1),
    };
    // Times must never run backwards along a trip.
    let clock = 0;
    for (const tm of times) {
      const a = Math.max(tm.arr, clock);
      const d = Math.max(tm.dep, a);
      trip.arr.push(a);
      trip.dep.push(d);
      clock = d;
    }
    for (const s of trip.stops) served[s] = true;
    trips.push(trip);
  }

  return {
    feedVersionId,
    stops,
    byId,
    served,
    trips,
    footpaths: buildFootpaths(stops, served),
    hasWheelchairData: trips.some((t) => t.wheelchair === 1),
  };
}

/** Arrival/departure per stop; stops without times are interpolated between their neighbours. null if impossible. */
function fillTimes(rows: TimeRow[]): { arr: number; dep: number }[] | null {
  const rep = rows.map((r) => r.departure_sec ?? r.arrival_sec);
  const known = rep.flatMap((v, i) => (v === null ? [] : [i]));
  if (known[0] !== 0 || known[known.length - 1] !== rows.length - 1) return null;
  for (let i = 1; i < rep.length - 1; i++) {
    if (rep[i] !== null) continue;
    const lo = known.filter((k) => k < i).pop()!;
    const hi = known.find((k) => k > i)!;
    rep[i] = Math.round(rep[lo]! + ((rep[hi]! - rep[lo]!) * (i - lo)) / (hi - lo));
  }
  return rows.map((r, i) => ({ arr: Number(r.arrival_sec ?? rep[i]), dep: Number(r.departure_sec ?? rep[i]) }));
}

/** Walkable stop pairs (<= TRANSFER_WALK_M) among served stops, found through a lat/lon grid. */
function buildFootpaths(stops: NetStop[], served: boolean[]): Footpath[][] {
  const out: Footpath[][] = stops.map(() => []);
  const active = stops.filter((s) => served[s.idx]);
  if (active.length === 0) return out;
  const meanLat = active.reduce((sum, s) => sum + s.lat, 0) / active.length;
  const cellLat = 0.0025; // ~275 m
  const cellLon = cellLat / Math.max(0.2, Math.cos((meanLat * Math.PI) / 180));
  const key = (i: number, j: number) => `${i}|${j}`;
  const cell = (s: NetStop): [number, number] => [Math.floor(s.lat / cellLat), Math.floor(s.lon / cellLon)];
  const grid = new Map<string, NetStop[]>();
  for (const s of active) {
    const [i, j] = cell(s);
    const list = grid.get(key(i, j));
    if (list) list.push(s);
    else grid.set(key(i, j), [s]);
  }
  for (const s of active) {
    const [ci, cj] = cell(s);
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        for (const o of grid.get(key(i, j)) ?? []) {
          if (o.idx === s.idx) continue;
          const meters = haversineMeters(s.lat, s.lon, o.lat, o.lon);
          if (meters <= TRANSFER_WALK_M) out[s.idx]!.push({ to: o.idx, meters });
        }
      }
    }
    out[s.idx]!.sort((a, b) => a.meters - b.meters || a.to - b.to);
  }
  return out;
}
