import type {
  Clock, Db, Envelope, FindStopsNearbyInput, GetArrivalsInput, GetFeedStatusInput, GetRouteInput,
  GetServiceAlertsInput, GetVehiclePositionsInput, PlanTripInput, PredictionType, RealtimeSource, SearchRoutesInput,
  OccupancyStatus, ProviderConfig,
} from '@lkt/core';

/** All ids in outputs are canonical (`lmt:stop:22`); inputs accept canonical ids and, for convenience, bare source ids. */

export interface RouteRef {
  route_id: string;
  short_name: string | null;
  long_name: string | null;
}

export interface StopNearby {
  stop_id: string;
  name: string;
  code: string | null;
  latitude: number;
  longitude: number;
  distance_m: number;
  routes: RouteRef[];
}

export interface Arrival {
  route: RouteRef;
  direction_id: number | null;
  headsign: string | null;
  /** Canonical static trip id of the scheduled trip this row is based on (null for live-only rows). */
  trip_id: string | null;
  vehicle_id: string | null;
  /** Timetable time at this stop (ISO, +05:30), or null for live-only rows with no scheduled match. */
  scheduled_time: string | null;
  /** Best estimate (live when available, else scheduled). */
  estimated_time: string;
  delay_seconds: number | null;
  minutes_until: number;
  prediction_type: PredictionType;
  /** Age of the live data this row relies on, null for pure schedule. */
  live_age_seconds: number | null;
}

export interface VehicleOut {
  vehicle_id: string | null;
  label: string | null;
  route: RouteRef | null;
  direction_id: number | null;
  latitude: number;
  longitude: number;
  bearing: number | null;
  speed_kmh: number | null;
  observed_at: string;
  age_seconds: number;
  freshness: 'fresh' | 'stale';
  occupancy_status: OccupancyStatus | null;
  occupancy_percentage: number | null;
  /** Realtime trip reference exactly as the provider published it (not joinable to static trips for LMT). */
  provider_trip_ref: string | null;
}

export interface RouteSummary extends RouteRef {
  route_type: number;
  color: string | null;
  text_color: string | null;
  headsigns: string[];
}

export interface RouteStop {
  stop_id: string;
  name: string;
  sequence: number;
  latitude: number;
  longitude: number;
}

export interface RouteDirection {
  direction_id: number | null;
  headsign: string | null;
  stops: RouteStop[];
  first_departure: string | null;
  last_departure: string | null;
  trips_per_day: number;
}

export interface RouteDetail {
  route: RouteSummary;
  directions: RouteDirection[];
  /** Whether any trip of this route runs on the Colombo service date `as_of`. */
  runs_today: boolean;
}

export interface AlertOut {
  alert_id: string;
  cause: string | null;
  effect: string | null;
  header: string | null;
  description: string | null;
  url: string | null;
  routes: string[];
  stops: string[];
  active_from: string | null;
  active_until: string | null;
}

export interface FeedStatusOut {
  provider: string;
  name: string;
  static: {
    active_feed_version: string | null;
    activated_at: string | null;
    calendar_end: string | null;
    calendar_days_remaining: number | null;
    counts: Record<string, number>;
  };
  realtime: Record<
    'vehicle_positions' | 'trip_updates' | 'alerts',
    {
      ok: boolean;
      last_success: string | null;
      header_age_seconds: number | null;
      freshness: 'fresh' | 'stale' | 'unavailable';
      entity_count: number;
      quarantined_count: number;
      consecutive_failures: number;
    }
  >;
  quality: { vehicle_orphan_ratio: number; trip_update_orphan_ratio: number };
  overall: 'healthy' | 'degraded' | 'down';
  notes: string[];
}

export interface ProviderOut {
  provider: string;
  name: string;
  timezone: string;
  license: ProviderConfig['license'];
}

export interface TripLeg {
  mode: 'bus' | 'walk';
  route?: RouteRef;
  headsign?: string | null;
  from_stop: { stop_id: string; name: string };
  to_stop: { stop_id: string; name: string };
  departs: string;
  arrives: string;
  prediction_type?: PredictionType;
  walk_meters?: number;
}

export interface Journey {
  departs: string;
  arrives: string;
  duration_minutes: number;
  transfers: number;
  legs: TripLeg[];
  assumptions: string[];
}

export interface QueryContext {
  db: Db;
  realtime: RealtimeSource;
  clock: Clock;
  /** Provider registry. */
  providers: Record<string, ProviderConfig>;
  defaultProvider: string;
}

/** The contract between the query layer and everything above it (REST, MCP). Every method returns an Envelope. */
export interface TransitQueries {
  listProviders(): Promise<ProviderOut[]>;
  findStopsNearby(input: FindStopsNearbyInput): Promise<Envelope<StopNearby[]>>;
  getArrivals(input: GetArrivalsInput): Promise<Envelope<Arrival[]>>;
  getVehiclePositions(input: GetVehiclePositionsInput): Promise<Envelope<VehicleOut[]>>;
  searchRoutes(input: SearchRoutesInput): Promise<Envelope<RouteSummary[]>>;
  getRoute(input: GetRouteInput): Promise<Envelope<RouteDetail>>;
  getServiceAlerts(input: GetServiceAlertsInput): Promise<Envelope<AlertOut[]>>;
  getFeedStatus(input: GetFeedStatusInput): Promise<Envelope<FeedStatusOut>>;
  planTrip(input: PlanTripInput): Promise<Envelope<Journey[]>>;
}
