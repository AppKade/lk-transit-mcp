import type { Envelope, FindStopsNearbyInput, GetArrivalsInput, GetFeedStatusInput, GetRouteInput, GetServiceAlertsInput, GetVehiclePositionsInput, PlanTripInput, SearchRoutesInput, ToolName } from '@lkt/core';
import { TOOL_INPUTS } from '@lkt/core';
import type { AlertOut, Arrival, FeedStatusOut, Journey, RouteDetail, RouteSummary, StopNearby, TransitQueries, VehicleOut } from '@lkt/query';
import { invalidArgument, normalizeError, errorBody, type NormalizedError } from './errors.js';

/** Sent as `instructions` in the MCP initialize result; read by the host once per session. */
export const SERVER_INSTRUCTIONS = `Read-only public transit data for Sri Lanka (currently Lanka Metro Transit, provider id "lmt").
Always cite provider, source and as_of when you answer, and say whether a time is live or timetable.
Every result has an envelope: freshness.status is fresh | stale | unavailable. If stale or unavailable, tell the user the live data is out of date and do not present it as live.
Arrival rows carry prediction_type: "scheduled" = timetable only (no live data); "provider_live" = from a fresh GPS-based TripUpdate feed; "derived_live" = computed from fresh GPS positions; "stale" = live data was too old, scheduled_time is shown instead.
Coordinates are used only to answer the query and are not stored. Never invent stop or route ids: get them from find_stops_nearby or search_routes. On an error result, read error.code and recover (e.g. unknown_stop: search again; provider_unavailable: tell the user and retry later).`;

interface ToolDef {
  title: string;
  description: string;
  dataType: 'array' | 'object';
  run(q: TransitQueries, input: never): Promise<Envelope<unknown>>;
  /** Compact human/LLM-readable lines for the text content fallback. */
  summarize(data: never): string[];
}

const MAX_LINES = 15;
const hhmm = (iso: string | null) => (iso ? iso.slice(11, 16) : '--:--');
const names = (r: { short_name: string | null; long_name: string | null }) => r.short_name ?? r.long_name ?? '?';

export const TOOLS: Record<ToolName, ToolDef> = {
  find_stops_nearby: {
    title: 'Find stops near a location',
    description:
      'Find bus stops around a latitude/longitude, nearest first, with the routes serving each stop. Call this first when the user gives a place or position and you need a stop_id for get_arrivals. radius_m 50-5000 (default 800), limit up to 50. The coordinates are used for the lookup and not stored. Returns stop_id values in canonical form (e.g. "lmt:stop:22"); pass them unchanged to other tools. Check freshness/source in the envelope: stop data is static timetable data (gtfs_static), so freshness reflects the active feed version, not live status.',
    dataType: 'array',
    run: (q, i: FindStopsNearbyInput) => q.findStopsNearby(i),
    summarize: (d: StopNearby[]) =>
      d.map((s) => `- ${s.name} [${s.stop_id}] ${Math.round(s.distance_m)} m; routes: ${s.routes.map(names).join(', ') || 'none'}`),
  },
  get_arrivals: {
    title: 'Upcoming arrivals at a stop',
    description:
      'Upcoming bus arrivals at one stop within the next within_minutes (1-180, default 60), sorted by best-estimate time. Call this for "when is the next bus" questions, using a stop_id from find_stops_nearby. Each row has scheduled_time, estimated_time, delay_seconds and prediction_type: "scheduled" = timetable only, no live data; "provider_live" = from a fresh live feed; "derived_live" = computed from fresh GPS; "stale" = live data was too old so only the timetable time is reliable. Never describe "scheduled" or "stale" rows as live or real-time. Optionally filter by route_id. Always state the as_of time and the prediction_type when answering.',
    dataType: 'array',
    run: (q, i: GetArrivalsInput) => q.getArrivals(i),
    summarize: (d: Arrival[]) =>
      d.map(
        (a) =>
          `- ${names(a.route)} ${a.headsign ?? ''} ${hhmm(a.estimated_time)} (in ${a.minutes_until} min, ${a.prediction_type}${a.delay_seconds ? `, delay ${a.delay_seconds}s` : ''}${a.scheduled_time ? `, timetable ${hhmm(a.scheduled_time)}` : ''})`,
      ),
  },
  get_vehicle_positions: {
    title: 'Live vehicle positions',
    description:
      'Currently observed bus positions from the live GPS feed, optionally filtered by route_id, trip_id or a bbox [west,south,east,north]. Vehicles older than max_age_seconds (default 90) are excluded; widen it only if you will tell the user the positions are old (rows then carry freshness "stale"). Use for "where is the bus" questions. Each row has observed_at and age_seconds: report them. An empty list with envelope freshness "stale" or "unavailable" means the live feed is down, not that no buses are running. Vehicle ids are operational identifiers, not driver identities.',
    dataType: 'array',
    run: (q, i: GetVehiclePositionsInput) => q.getVehiclePositions(i),
    summarize: (d: VehicleOut[]) =>
      d.map(
        (v) =>
          `- ${v.vehicle_id ?? v.label ?? 'vehicle'} route ${v.route ? names(v.route) : '?'} at ${v.latitude},${v.longitude} (${v.freshness}, ${v.age_seconds}s old)`,
      ),
  },
  search_routes: {
    title: 'Search routes',
    description:
      'Find routes by number, name or a stop name on the route (case-insensitive), e.g. "CM01" or "Makumbura". Call this to turn a route number the user mentioned into a route_id for get_route or get_arrivals filters. limit up to 50 (default 10).',
    dataType: 'array',
    run: (q, i: SearchRoutesInput) => q.searchRoutes(i),
    summarize: (d: RouteSummary[]) =>
      d.map((r) => `- ${r.short_name ?? ''} ${r.long_name ?? ''} [${r.route_id}]${r.headsigns.length ? ` to ${r.headsigns.join(' / ')}` : ''}`),
  },
  get_route: {
    title: 'Route detail',
    description:
      'One route with its directions, ordered stop pattern, first/last departure, trips per day and whether it runs today (Asia/Colombo service date). Use for "does CM01 run today", "which stops does it serve", "when is the last bus". route_id comes from search_routes; direction_id (0 or 1) narrows to one direction. This is timetable data: it says nothing about live vehicles.',
    dataType: 'object',
    run: (q, i: GetRouteInput) => q.getRoute(i),
    summarize: (d: RouteDetail) => [
      `${names(d.route)} ${d.route.long_name ?? ''} [${d.route.route_id}] runs_today=${d.runs_today}`,
      ...d.directions.map(
        (x) =>
          `- direction ${x.direction_id ?? '?'} to ${x.headsign ?? '?'}: ${x.stops.length} stops (${x.stops[0]?.name ?? '?'} -> ${x.stops[x.stops.length - 1]?.name ?? '?'}), first ${hhmm(x.first_departure)}, last ${hhmm(x.last_departure)}, ${x.trips_per_day} trips/day`,
      ),
    ],
  },
  plan_trip: {
    title: 'Plan a trip',
    description:
      'Plan a journey between two places, each given as a stop_id or as latitude+longitude. Returns direct and one- or two-transfer options (max_transfers 0-2, default 1) on the timetable, with live delays overlaid only when the live feed is fresh; each leg has prediction_type. Walking and transfer assumptions are returned in "assumptions": repeat them to the user. departure_time is an ISO 8601 timestamp with offset (default: now). Coordinates are used for the search and not stored. Results are planned from the schedule, so say so unless legs are provider_live.',
    dataType: 'array',
    run: (q, i: PlanTripInput) => q.planTrip(i),
    summarize: (d: Journey[]) =>
      d.length === 0
        ? ['No journey found.']
        : d.flatMap((j, n) => [
            `Option ${n + 1}: depart ${hhmm(j.departs)} arrive ${hhmm(j.arrives)} (${j.duration_minutes} min, ${j.transfers} transfers)`,
            ...j.legs.map(
              (l) =>
                `  - ${l.mode === 'walk' ? `walk ${l.walk_meters ?? '?'} m` : `bus ${l.route ? names(l.route) : ''}`} ${l.from_stop.name} -> ${l.to_stop.name} ${hhmm(l.departs)}-${hhmm(l.arrives)}${l.prediction_type ? ` (${l.prediction_type})` : ''}`,
            ),
            ...j.assumptions.map((a) => `  assumption: ${a}`),
          ]),
  },
  get_service_alerts: {
    title: 'Service alerts',
    description:
      'Active service disruptions (detours, cancellations, delays), optionally filtered by route_id or stop_id; only alerts whose active period includes now are returned. Call this when the user asks about disruptions or when arrivals look unusual. An empty list with envelope freshness "fresh" means no known alerts; with "stale" or "unavailable" it means the alerts feed is not current and you must not say "no disruptions".',
    dataType: 'array',
    run: (q, i: GetServiceAlertsInput) => q.getServiceAlerts(i),
    summarize: (d: AlertOut[]) =>
      d.length === 0 ? ['No active alerts.'] : d.map((a) => `- [${a.effect ?? 'ALERT'}] ${a.header ?? ''} ${a.description ?? ''} (routes: ${a.routes.join(', ') || 'all'})`.trim()),
  },
  get_feed_status: {
    title: 'Data feed status',
    description:
      'Health of a provider\'s data: active timetable version and how many days of calendar remain, plus for each live feed (vehicle_positions, trip_updates, alerts) whether it is ok, its freshness (fresh | stale | unavailable), age, entity count and quarantined count, and an overall verdict healthy | degraded | down. Call this before claiming something is "live" if you have doubts, or when results look empty or odd. If overall is degraded or down, tell the user which live data is unreliable.',
    dataType: 'object',
    run: (q, i: GetFeedStatusInput) => q.getFeedStatus(i),
    summarize: (d: FeedStatusOut) => [
      `${d.name}: overall ${d.overall}; timetable ${d.static.active_feed_version ?? 'none'} (${d.static.calendar_days_remaining ?? '?'} calendar days left)`,
      ...Object.entries(d.realtime).map(
        ([k, f]) => `- ${k}: ${f.freshness}${f.header_age_seconds === null ? '' : ` (${f.header_age_seconds}s old)`}, ${f.entity_count} entities, ${f.quarantined_count} quarantined, ok=${f.ok}`,
      ),
      ...d.notes.map((n) => `note: ${n}`),
    ],
  },
};

export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

export function isToolName(s: string): s is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_INPUTS, s);
}

function envelopeHeader(e: Envelope<unknown>): string {
  const f = e.freshness;
  const age = f.age_seconds === null ? '' : ` age=${f.age_seconds}s limit=${f.threshold_seconds}s`;
  const s = e.source;
  return `provider=${e.provider} as_of=${e.as_of} freshness=${f.status}${age} source=${s.type}[${s.url_ref.join(',')}] feed_version=${s.feed_version ?? 'n/a'} license=${s.license} (${s.license_status}; authority ${s.provider_authority}) attribution="${s.attribution}"`;
}

export function envelopeText(name: ToolName, e: Envelope<unknown>): string {
  const lines = (TOOLS[name].summarize as (d: unknown) => string[])(e.data);
  const shown = lines.slice(0, MAX_LINES);
  const more = lines.length > shown.length ? [`... ${lines.length - shown.length} more (see structuredContent)`] : [];
  return [envelopeHeader(e), ...shown, ...more].join('\n');
}

export interface ToolCallResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

export function toolErrorResult(e: Pick<NormalizedError, 'code' | 'message' | 'details'>): ToolCallResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error [${e.code}]: ${e.message}` }],
    structuredContent: errorBody(e) as unknown as Record<string, unknown>,
  };
}

export interface ToolCallInfo {
  tool?: string;
  provider?: string;
  error_code?: string;
}

/**
 * Validates `rawArgs` with the shared zod schema, runs the query and shapes the MCP result. Never throws: every
 * failure becomes an `isError` result with a structured `{error:{code,message}}` the model can act on.
 */
export async function callTool(queries: TransitQueries, name: ToolName, rawArgs: unknown, info: ToolCallInfo = {}): Promise<ToolCallResult> {
  info.tool = name;
  try {
    const parsed = TOOL_INPUTS[name].safeParse(rawArgs ?? {});
    if (!parsed.success) throw invalidArgument(parsed.error);
    const args = parsed.data as { provider?: string };
    if (args.provider) info.provider = args.provider;
    const env = await TOOLS[name].run(queries, parsed.data as never);
    info.provider = env.provider;
    return {
      content: [{ type: 'text', text: envelopeText(name, env) }],
      structuredContent: env as unknown as Record<string, unknown>,
    };
  } catch (err) {
    const n = normalizeError(err);
    info.error_code = n.code;
    return toolErrorResult(n);
  }
}
