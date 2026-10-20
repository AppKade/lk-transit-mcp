import { z } from 'zod';

const provider = z.string().min(1).max(32).optional();
const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);

export const findStopsNearbyInput = z
  .object({
    latitude: lat,
    longitude: lon,
    radius_m: z.number().int().min(50).max(5000).default(800),
    provider,
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();

export const getArrivalsInput = z
  .object({
    stop_id: z.string().min(1).max(128),
    within_minutes: z.number().int().min(1).max(180).default(60),
    route_id: z.string().min(1).max(128).optional(),
    provider,
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const getVehiclePositionsInput = z
  .object({
    provider,
    route_id: z.string().min(1).max(128).optional(),
    trip_id: z.string().min(1).max(128).optional(),
    bbox: z.tuple([lon, lat, lon, lat]).optional().describe('[west,south,east,north]'),
    max_age_seconds: z.number().int().min(1).max(600).default(90),
  })
  .strict();

export const searchRoutesInput = z
  .object({
    query: z.string().min(1).max(100),
    provider,
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();

export const getRouteInput = z
  .object({
    route_id: z.string().min(1).max(128),
    direction_id: z.union([z.literal(0), z.literal(1)]).optional(),
  })
  .strict();

const place = z
  .object({ stop_id: z.string().min(1).max(128).optional(), latitude: lat.optional(), longitude: lon.optional() })
  .strict()
  .refine((p) => !!p.stop_id || (p.latitude !== undefined && p.longitude !== undefined), {
    message: 'Provide stop_id, or both latitude and longitude',
  });

export const planTripInput = z
  .object({
    origin: place,
    destination: place,
    departure_time: z.string().datetime({ offset: true }).optional(),
    max_transfers: z.number().int().min(0).max(2).default(1),
    wheelchair_accessible: z.boolean().default(false),
  })
  .strict();

export const getServiceAlertsInput = z
  .object({ provider, route_id: z.string().min(1).max(128).optional(), stop_id: z.string().min(1).max(128).optional() })
  .strict();

export const getFeedStatusInput = z.object({ provider }).strict();

export const TOOL_INPUTS = {
  find_stops_nearby: findStopsNearbyInput,
  get_arrivals: getArrivalsInput,
  get_vehicle_positions: getVehiclePositionsInput,
  search_routes: searchRoutesInput,
  get_route: getRouteInput,
  plan_trip: planTripInput,
  get_service_alerts: getServiceAlertsInput,
  get_feed_status: getFeedStatusInput,
} as const;

export type ToolName = keyof typeof TOOL_INPUTS;

export type FindStopsNearbyInput = z.infer<typeof findStopsNearbyInput>;
export type GetArrivalsInput = z.infer<typeof getArrivalsInput>;
export type GetVehiclePositionsInput = z.infer<typeof getVehiclePositionsInput>;
export type SearchRoutesInput = z.infer<typeof searchRoutesInput>;
export type GetRouteInput = z.infer<typeof getRouteInput>;
export type PlanTripInput = z.infer<typeof planTripInput>;
export type GetServiceAlertsInput = z.infer<typeof getServiceAlertsInput>;
export type GetFeedStatusInput = z.infer<typeof getFeedStatusInput>;

export type PredictionType = 'scheduled' | 'provider_live' | 'derived_live' | 'stale';

/** Structured, model-recoverable error codes. */
export type ToolErrorCode =
  | 'invalid_argument'
  | 'unknown_stop'
  | 'unknown_route'
  | 'unknown_provider'
  | 'provider_unavailable'
  | 'rate_limited'
  | 'internal';

export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}
