/**
 * Realtime entities as held by the platform after decoding and resolution.
 * Times are epoch milliseconds (UTC). IDs are the provider's *source* IDs; canonical ids are built at the API edge.
 */

/**
 * How a realtime reference was mapped onto the active static feed.
 * LMT's realtime trip ids (e.g. `LMT_CM01_0_WP-NE-5208`) do NOT equal static trip ids (`TRIP_CM01_D0_T1`) and the
 * realtime route id is the short name (`CM03`) while static route_id is a UUID, so resolution is by route short
 * name + direction, not trip id.
 */
export interface Resolution {
  /** Static route_id in the active feed, or null if unresolved. */
  route_id: string | null;
  direction_id: number | null;
  /** Static trip_id when the realtime trip id matched exactly; usually null for LMT. */
  static_trip_id: string | null;
  method: 'trip_id' | 'route_short_name' | 'route_id' | 'unresolved';
}

export type OccupancyStatus =
  | 'EMPTY'
  | 'MANY_SEATS_AVAILABLE'
  | 'FEW_SEATS_AVAILABLE'
  | 'STANDING_ROOM_ONLY'
  | 'CRUSHED_STANDING_ROOM_ONLY'
  | 'FULL'
  | 'NOT_ACCEPTING_PASSENGERS'
  | 'NO_DATA_AVAILABLE'
  | 'NOT_BOARDABLE';

export interface RtVehicle {
  entity_id: string;
  vehicle_id: string | null;
  label: string | null;
  license_plate: string | null;
  trip_id: string | null;
  route_id_raw: string | null;
  direction_id: number | null;
  latitude: number;
  longitude: number;
  bearing: number | null;
  speed_mps: number | null;
  current_stop_id: string | null;
  current_status: string | null;
  /** Vehicle observation time (entity timestamp, falling back to feed header). */
  observed_at_ms: number;
  occupancy_status: OccupancyStatus | null;
  occupancy_percentage: number | null;
  resolution: Resolution;
}

export interface RtStopTimeUpdate {
  stop_sequence: number | null;
  stop_id: string | null;
  arrival_time_ms: number | null;
  arrival_delay_s: number | null;
  departure_time_ms: number | null;
  departure_delay_s: number | null;
  schedule_relationship: 'SCHEDULED' | 'SKIPPED' | 'NO_DATA' | 'UNSCHEDULED';
}

export interface RtTripUpdate {
  entity_id: string;
  trip_id: string | null;
  route_id_raw: string | null;
  direction_id: number | null;
  start_date: string | null;
  vehicle_id: string | null;
  schedule_relationship: 'SCHEDULED' | 'ADDED' | 'UNSCHEDULED' | 'CANCELED' | 'DUPLICATED' | 'DELETED';
  /** Trip-level update timestamp, falling back to feed header. */
  observed_at_ms: number;
  stop_time_updates: RtStopTimeUpdate[];
  resolution: Resolution;
}

export interface RtAlertEntitySelector {
  agency_id: string | null;
  route_id: string | null;
  stop_id: string | null;
  trip_id: string | null;
}

export interface RtAlert {
  entity_id: string;
  cause: string | null;
  effect: string | null;
  header: string | null;
  description: string | null;
  url: string | null;
  /** start/end may be open ended. */
  active_periods: { start_ms: number | null; end_ms: number | null }[];
  informed_entities: RtAlertEntitySelector[];
  observed_at_ms: number;
}

export type RealtimeFeedKey = 'vehicle_positions' | 'trip_updates' | 'alerts';

export interface FeedState {
  ok: boolean;
  last_attempt_ms: number | null;
  last_success_ms: number | null;
  /** FeedHeader.timestamp of the last successfully decoded payload; the basis for freshness. */
  header_timestamp_ms: number | null;
  entity_count: number;
  quarantined_count: number;
  consecutive_failures: number;
  last_error: string | null;
}

export interface RealtimeQuality {
  /** Fraction of vehicles / trip updates whose route could not be resolved against the active static feed. */
  vehicle_orphan_ratio: number;
  trip_update_orphan_ratio: number;
  /** Static feed version the resolutions were computed against. */
  resolved_against_feed_version: string | null;
}

export interface RealtimeSnapshot {
  provider: string;
  vehicles: RtVehicle[];
  tripUpdates: RtTripUpdate[];
  alerts: RtAlert[];
  feeds: Record<RealtimeFeedKey, FeedState>;
  quality: RealtimeQuality;
}

export function emptyFeedState(): FeedState {
  return {
    ok: false,
    last_attempt_ms: null,
    last_success_ms: null,
    header_timestamp_ms: null,
    entity_count: 0,
    quarantined_count: 0,
    consecutive_failures: 0,
    last_error: null,
  };
}

export function emptySnapshot(provider: string): RealtimeSnapshot {
  return {
    provider,
    vehicles: [],
    tripUpdates: [],
    alerts: [],
    feeds: {
      vehicle_positions: emptyFeedState(),
      trip_updates: emptyFeedState(),
      alerts: emptyFeedState(),
    },
    quality: { vehicle_orphan_ratio: 0, trip_update_orphan_ratio: 0, resolved_against_feed_version: null },
  };
}
