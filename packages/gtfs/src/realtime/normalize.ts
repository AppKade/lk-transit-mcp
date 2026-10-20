import {
  inSriLanka,
  type OccupancyStatus,
  type Resolution,
  type RtAlert,
  type RtAlertEntitySelector,
  type RtStopTimeUpdate,
  type RtTripUpdate,
  type RtVehicle,
} from '@lkt/core';
import type { DecodedFeed } from './decode.js';
import type { transit_realtime as T } from './proto.js';
import { has, optFloat, optInt, secondsToMs, str, toNumber } from './util.js';

export interface Quarantined {
  entity_id: string;
  reason: string;
}

export interface NormalizeResult<R> {
  items: R[];
  quarantined: Quarantined[];
}

export interface RtLimits {
  /** Entity timestamps further ahead than this are rejected. */
  maxFutureMs: number;
  /** Entity timestamps older than this are rejected. */
  maxAgeMs: number;
  /** A predicted time may precede the observation by at most this much (recently passed stops are normal). */
  predictionPastToleranceMs: number;
  /** Predictions further ahead than this are implausible. */
  maxPredictionHorizonMs: number;
}

export const DEFAULT_LIMITS: RtLimits = {
  maxFutureMs: 5 * 60_000,
  maxAgeMs: 24 * 3600_000,
  predictionPastToleranceMs: 120_000,
  maxPredictionHorizonMs: 24 * 3600_000,
};

export interface NormalizeOptions {
  /** "Now" for sanity checks; callers pass their injected clock. */
  nowMs: number;
  limits?: Partial<RtLimits>;
}

export function unresolvedResolution(): Resolution {
  return { route_id: null, direction_id: null, static_trip_id: null, method: 'unresolved' };
}

export interface ParsedTripId {
  agency: string;
  route: string;
  direction: number;
  vehicle: string;
}

/** `<agency>_<routeShortName>_<direction>_<vehicle>`, e.g. `LMT_CM01_0_WP-NE-5208`. Static ids (`TRIP_CM01_D0_T1`) do not match. */
export function parseTripId(tripId: string | null | undefined): ParsedTripId | null {
  if (!tripId) return null;
  const m = /^([^_]+)_([^_]+)_([01])_(.+)$/.exec(tripId);
  if (!m) return null;
  return { agency: m[1]!, route: m[2]!, direction: Number(m[3]), vehicle: m[4]! };
}

const OCCUPANCY: Record<number, OccupancyStatus> = {
  0: 'EMPTY',
  1: 'MANY_SEATS_AVAILABLE',
  2: 'FEW_SEATS_AVAILABLE',
  3: 'STANDING_ROOM_ONLY',
  4: 'CRUSHED_STANDING_ROOM_ONLY',
  5: 'FULL',
  6: 'NOT_ACCEPTING_PASSENGERS',
  7: 'NO_DATA_AVAILABLE',
  8: 'NOT_BOARDABLE',
};
const STOP_STATUS: Record<number, string> = { 0: 'INCOMING_AT', 1: 'STOPPED_AT', 2: 'IN_TRANSIT_TO' };
const TRIP_REL: Record<number, RtTripUpdate['schedule_relationship']> = {
  0: 'SCHEDULED',
  1: 'ADDED',
  2: 'UNSCHEDULED',
  3: 'CANCELED',
  5: 'ADDED', // REPLACEMENT is deprecated; core has no equivalent and it behaves like an added trip
  6: 'DUPLICATED',
  7: 'DELETED',
};
const STOP_REL: Record<number, RtStopTimeUpdate['schedule_relationship']> = {
  0: 'SCHEDULED',
  1: 'SKIPPED',
  2: 'NO_DATA',
  3: 'UNSCHEDULED',
};
const CAUSE: Record<number, string> = {
  1: 'UNKNOWN_CAUSE', 2: 'OTHER_CAUSE', 3: 'TECHNICAL_PROBLEM', 4: 'STRIKE', 5: 'DEMONSTRATION', 6: 'ACCIDENT',
  7: 'HOLIDAY', 8: 'WEATHER', 9: 'MAINTENANCE', 10: 'CONSTRUCTION', 11: 'POLICE_ACTIVITY', 12: 'MEDICAL_EMERGENCY',
};
const EFFECT: Record<number, string> = {
  1: 'NO_SERVICE', 2: 'REDUCED_SERVICE', 3: 'SIGNIFICANT_DELAYS', 4: 'DETOUR', 5: 'ADDITIONAL_SERVICE',
  6: 'MODIFIED_SERVICE', 7: 'OTHER_EFFECT', 8: 'UNKNOWN_EFFECT', 9: 'STOP_MOVED', 10: 'NO_EFFECT', 11: 'ACCESSIBILITY_ISSUE',
};

function limitsOf(opts: NormalizeOptions): RtLimits {
  return { ...DEFAULT_LIMITS, ...opts.limits };
}

function timestampProblem(ms: number, nowMs: number, l: RtLimits): string | null {
  if (ms > nowMs + l.maxFutureMs) return 'timestamp_in_future';
  if (ms < nowMs - l.maxAgeMs) return 'timestamp_too_old';
  return null;
}

/** Entity timestamp if present, else the feed header's. */
function observedAt(entityTs: unknown, hasTs: boolean, feed: DecodedFeed): number {
  return (hasTs ? secondsToMs(entityTs) : null) ?? feed.header.timestamp_ms;
}

interface Walk<R> {
  out: NormalizeResult<R>;
  /** Returns the entity id, or null when the entity must be skipped (deleted) or was quarantined as a duplicate. */
  admit(e: T.IFeedEntity, index: number): string | null;
  reject(id: string, reason: string): void;
}

function walker<R>(): Walk<R> {
  const out: NormalizeResult<R> = { items: [], quarantined: [] };
  const seen = new Set<string>();
  return {
    out,
    admit(e, index) {
      const id = str(e.id) ?? `(entity #${index})`;
      if (e.isDeleted) return null;
      if (seen.has(id)) {
        out.quarantined.push({ entity_id: id, reason: 'duplicate_entity_id' });
        return null;
      }
      seen.add(id);
      return id;
    },
    reject(id, reason) {
      out.quarantined.push({ entity_id: id, reason });
    },
  };
}

export function normalizeVehicles(feed: DecodedFeed, opts: NormalizeOptions): NormalizeResult<RtVehicle> {
  const limits = limitsOf(opts);
  const w = walker<RtVehicle>();
  feed.entities.forEach((e, i) => {
    const id = w.admit(e, i);
    if (id === null) return;
    const v = e.vehicle;
    if (!v) return w.reject(id, 'missing_vehicle');
    const p = v.position;
    if (!p) return w.reject(id, 'missing_position');
    const lat = toNumber(p.latitude);
    const lon = toNumber(p.longitude);
    if (lat === null || lon === null || !has(p, 'latitude') || !has(p, 'longitude') || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return w.reject(id, 'invalid_coordinates');
    }
    if (!inSriLanka(lat, lon)) return w.reject(id, 'outside_sri_lanka');
    const observed = observedAt(v.timestamp, has(v, 'timestamp'), feed);
    const tsProblem = timestampProblem(observed, opts.nowMs, limits);
    if (tsProblem) return w.reject(id, tsProblem);

    const tripId = str(v.trip?.tripId);
    const parsed = parseTripId(tripId);
    const bearing = optFloat(p, 'bearing');
    const speed = optFloat(p, 'speed');
    const occ = has(v, 'occupancyStatus') ? OCCUPANCY[v.occupancyStatus as number] ?? null : null;
    const pct = optFloat(v, 'occupancyPercentage');
    w.out.items.push({
      entity_id: id,
      vehicle_id: str(v.vehicle?.id),
      label: str(v.vehicle?.label),
      license_plate: str(v.vehicle?.licensePlate),
      trip_id: tripId,
      // Falls back to the id pattern because LMT vehicle positions carry no route_id.
      route_id_raw: str(v.trip?.routeId) ?? parsed?.route ?? null,
      direction_id: optInt(v.trip, 'directionId') ?? parsed?.direction ?? null,
      latitude: lat,
      longitude: lon,
      bearing: bearing !== null && bearing >= 0 && bearing <= 360 ? bearing : null,
      // GTFS-RT speed is metres per second; no unit conversion is applied.
      speed_mps: speed !== null && speed >= 0 ? speed : null,
      current_stop_id: str(v.stopId),
      current_status: has(v, 'currentStatus') ? STOP_STATUS[v.currentStatus as number] ?? null : null,
      observed_at_ms: observed,
      occupancy_status: occ,
      occupancy_percentage: pct !== null && pct >= 0 && pct <= 100 ? pct : null,
      resolution: unresolvedResolution(),
    });
  });
  return w.out;
}

function normalizeStopTimeUpdate(s: T.TripUpdate.IStopTimeUpdate): RtStopTimeUpdate {
  const arr = s.arrival;
  const dep = s.departure;
  return {
    stop_sequence: optInt(s, 'stopSequence'),
    stop_id: str(s.stopId),
    arrival_time_ms: has(arr, 'time') ? secondsToMs(arr?.time) : null,
    arrival_delay_s: optInt(arr, 'delay'),
    departure_time_ms: has(dep, 'time') ? secondsToMs(dep?.time) : null,
    departure_delay_s: optInt(dep, 'delay'),
    schedule_relationship: has(s, 'scheduleRelationship') ? STOP_REL[s.scheduleRelationship as number] ?? 'SCHEDULED' : 'SCHEDULED',
  };
}

function stopTimeProblem(stus: RtStopTimeUpdate[], observed: number, nowMs: number, l: RtLimits): string | null {
  let prevSeq: number | null = null;
  for (const s of stus) {
    if (s.stop_id === null && s.stop_sequence === null) return 'stop_time_update_missing_stop';
    if (s.stop_sequence !== null) {
      if (prevSeq !== null && s.stop_sequence <= prevSeq) return 'stop_time_updates_out_of_order';
      prevSeq = s.stop_sequence;
    }
    for (const t of [s.arrival_time_ms, s.departure_time_ms]) {
      if (t === null) continue;
      if (t < observed - l.predictionPastToleranceMs) return 'prediction_before_observation';
      if (t > nowMs + l.maxPredictionHorizonMs) return 'prediction_too_far_ahead';
    }
  }
  return null;
}

export function normalizeTripUpdates(feed: DecodedFeed, opts: NormalizeOptions): NormalizeResult<RtTripUpdate> {
  const limits = limitsOf(opts);
  const w = walker<RtTripUpdate>();
  feed.entities.forEach((e, i) => {
    const id = w.admit(e, i);
    if (id === null) return;
    const tu = e.tripUpdate;
    if (!tu) return w.reject(id, 'missing_trip_update');
    const tripId = str(tu.trip?.tripId);
    const routeRaw = str(tu.trip?.routeId);
    if (!tu.trip || (tripId === null && routeRaw === null)) return w.reject(id, 'missing_trip_reference');
    const observed = observedAt(tu.timestamp, has(tu, 'timestamp'), feed);
    const tsProblem = timestampProblem(observed, opts.nowMs, limits);
    if (tsProblem) return w.reject(id, tsProblem);
    const stus = (tu.stopTimeUpdate ?? []).map(normalizeStopTimeUpdate);
    const stopProblem = stopTimeProblem(stus, observed, opts.nowMs, limits);
    if (stopProblem) return w.reject(id, stopProblem);

    const parsed = parseTripId(tripId);
    const rel = tu.trip.scheduleRelationship;
    w.out.items.push({
      entity_id: id,
      trip_id: tripId,
      route_id_raw: routeRaw ?? parsed?.route ?? null,
      direction_id: optInt(tu.trip, 'directionId') ?? parsed?.direction ?? null,
      start_date: str(tu.trip.startDate),
      vehicle_id: str(tu.vehicle?.id),
      schedule_relationship: has(tu.trip, 'scheduleRelationship') ? TRIP_REL[rel as number] ?? 'SCHEDULED' : 'SCHEDULED',
      observed_at_ms: observed,
      stop_time_updates: stus,
      resolution: unresolvedResolution(),
    });
  });
  return w.out;
}

/** English first, then untagged, then whatever is there. */
function pickText(ts: T.ITranslatedString | null | undefined): string | null {
  const list = (ts?.translation ?? []).filter((t) => str(t.text) !== null);
  if (list.length === 0) return null;
  const lang = (t: T.TranslatedString.ITranslation) => (t.language ?? '').toLowerCase();
  const best = list.find((t) => lang(t).startsWith('en')) ?? list.find((t) => lang(t) === '') ?? list[0]!;
  return str(best.text);
}

/** Alerts carry no entity timestamp: observed_at is the header's, and a stale header must not empty the list. */
export function normalizeAlerts(feed: DecodedFeed, _opts?: NormalizeOptions): NormalizeResult<RtAlert> {
  const w = walker<RtAlert>();
  feed.entities.forEach((e, i) => {
    const id = w.admit(e, i);
    if (id === null) return;
    const a = e.alert;
    if (!a) return w.reject(id, 'missing_alert');
    const header = pickText(a.headerText);
    const description = pickText(a.descriptionText);
    if (header === null && description === null) return w.reject(id, 'missing_text');

    const informed: RtAlertEntitySelector[] = (a.informedEntity ?? []).map((s) => ({
      agency_id: str(s.agencyId),
      route_id: str(s.routeId),
      stop_id: str(s.stopId),
      trip_id: str(s.trip?.tripId),
    }));
    if (informed.length === 0 || informed.every((s) => !s.agency_id && !s.route_id && !s.stop_id && !s.trip_id)) {
      return w.reject(id, 'no_informed_entity');
    }
    const periods = (a.activePeriod ?? []).map((p) => ({ start_ms: secondsToMs(p.start), end_ms: secondsToMs(p.end) }));
    if (periods.some((p) => p.start_ms !== null && p.end_ms !== null && p.end_ms < p.start_ms)) {
      return w.reject(id, 'invalid_active_period');
    }
    w.out.items.push({
      entity_id: id,
      cause: has(a, 'cause') ? CAUSE[a.cause as number] ?? null : null,
      effect: has(a, 'effect') ? EFFECT[a.effect as number] ?? null : null,
      header,
      description,
      url: pickText(a.url),
      active_periods: periods,
      informed_entities: informed,
      observed_at_ms: feed.header.timestamp_ms,
    });
  });
  return w.out;
}

