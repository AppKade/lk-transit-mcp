import { addDays, colomboDate, inSriLanka, systemClock } from '@lkt/core';
import type { Clock } from '@lkt/core';
import type {
  FeedCounts,
  GtfsStop,
  GtfsStopTime,
  ParsedGtfs,
  Severity,
  ValidationIssue,
  ValidationReport,
} from './types.js';

export interface ValidationOptions {
  /** Injected clock for the future-service check. Default: system clock. */
  clock?: Clock;
  /** Overrides the clock: Colombo "today" as YYYY-MM-DD. */
  today?: string;
  /** Warn when the agency timezone differs (e.g. 'Asia/Colombo'). */
  expectedTimezone?: string;
  /**
   * Row-level problems (bad stops, trips, orphan stop_times) drop only the offending rows, unless more than this
   * fraction of trips, stops or stop_times is affected, in which case the feed is rejected. Default 0.02.
   */
  maxDropFraction?: number;
  /** Counts of the previous version (feed_versions.counts) for the change-band check. */
  previousCounts?: Partial<FeedCounts> | null;
  /** Relative change in routes/stops/trips that triggers needs_review. Default 0.5. */
  countChangeBand?: number;
  /** Warn when the last service day is closer than this many days. Default 14. */
  expiringSoonDays?: number;
  /** Max sample ids kept per issue. Default 5. */
  sampleSize?: number;
}

export interface PreparedGtfs {
  report: ValidationReport;
  /** The feed with offending rows removed and blank times filled in: what should be loaded. */
  feed: ParsedGtfs;
}

type Kind = 'fatal' | 'droppable' | 'warning';

interface Acc {
  kind: Kind;
  file?: string;
  message: string;
  count: number;
  samples: string[];
}

class Collector {
  readonly map = new Map<string, Acc>();
  constructor(private readonly sampleSize: number) {}
  add(rule: string, kind: Kind, message: string, sample?: string, file?: string, count = 1): void {
    let a = this.map.get(rule);
    if (!a) this.map.set(rule, (a = { kind, file, message, count: 0, samples: [] }));
    a.count += count;
    if (sample !== undefined && a.samples.length < this.sampleSize && !a.samples.includes(sample)) a.samples.push(sample);
  }
  hasFatal(): boolean {
    for (const a of this.map.values()) if (a.kind === 'fatal') return true;
    return false;
  }
}

const REQUIRED_FILES = ['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'];
const REQUIRED_COLUMNS: Record<string, string[]> = {
  'agency.txt': ['agency_name', 'agency_url', 'agency_timezone'],
  'stops.txt': ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'],
  'routes.txt': ['route_id', 'route_type'],
  'trips.txt': ['route_id', 'service_id', 'trip_id'],
  'stop_times.txt': ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'],
  'calendar.txt': [
    'service_id',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
    'start_date',
    'end_date',
  ],
  'calendar_dates.txt': ['service_id', 'date', 'exception_type'],
};

const emptyCounts = (): FeedCounts => ({
  agencies: 0,
  stops: 0,
  routes: 0,
  trips: 0,
  stop_times: 0,
  calendars: 0,
  calendar_dates: 0,
  shape_points: 0,
});

export function validateGtfs(parsed: ParsedGtfs, opts: ValidationOptions = {}): ValidationReport {
  return prepareGtfs(parsed, opts).report;
}

/** Validates and returns both the report and the cleaned feed (offending rows dropped). */
export function prepareGtfs(parsed: ParsedGtfs, opts: ValidationOptions = {}): PreparedGtfs {
  const today = opts.today ?? colomboDate((opts.clock ?? systemClock).now());
  const maxDrop = opts.maxDropFraction ?? 0.02;
  const c = new Collector(opts.sampleSize ?? 5);
  let droppedStops = 0;
  let droppedBlankTrips = 0;

  // 1. Structure: required files and columns.
  for (const f of REQUIRED_FILES) {
    if (!parsed.files[f]) c.add('file.missing', 'fatal', 'Required file is missing from the archive', f, f);
  }
  if (!parsed.files['calendar.txt'] && !parsed.files['calendar_dates.txt']) {
    c.add('file.missing', 'fatal', 'Required file is missing from the archive', 'calendar.txt|calendar_dates.txt');
  }
  for (const [file, cols] of Object.entries(REQUIRED_COLUMNS)) {
    const info = parsed.files[file];
    if (!info) continue;
    for (const col of cols) {
      if (!info.columns.includes(col)) c.add('column.missing', 'fatal', 'Required column is missing', `${file}:${col}`, file);
    }
    if (file === 'routes.txt' && !info.columns.includes('route_short_name') && !info.columns.includes('route_long_name')) {
      c.add('column.missing', 'fatal', 'Required column is missing', 'routes.txt:route_short_name|route_long_name', file);
    }
  }
  for (const f of ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt']) {
    if (parsed.files[f] && parsed.files[f].rows === 0) c.add('file.empty', 'fatal', 'File has a header but no rows', f, f);
  }
  if (c.hasFatal()) return finish(parsed, parsed, c, opts, today, maxDrop, true, 0, 0, 0, 0);

  // 2. Stops.
  const allStopIds = new Set<string>();
  const unusableStops = new Set<string>();
  const stops: GtfsStop[] = [];
  for (const s of parsed.stops) {
    if (s.stop_id === '' || s.stop_name === '') {
      c.add('stops.missing_field', 'droppable', 'Stop is missing stop_id or stop_name', s.stop_id || '(blank id)', 'stops.txt');
      droppedStops++;
      continue;
    }
    if (allStopIds.has(s.stop_id)) {
      c.add('stops.duplicate_id', 'fatal', 'stop_id is not unique', s.stop_id, 'stops.txt');
      continue;
    }
    allStopIds.add(s.stop_id);
    if (s.lat === null || s.lon === null || Math.abs(s.lat) > 90 || Math.abs(s.lon) > 180) {
      c.add('stops.invalid_coordinates', 'droppable', 'Stop latitude/longitude is missing or out of range', s.stop_id, 'stops.txt');
    } else if (!inSriLanka(s.lat, s.lon)) {
      c.add('stops.outside_sri_lanka', 'droppable', 'Stop lies outside the Sri Lanka bounding box', s.stop_id, 'stops.txt');
    } else {
      stops.push(s);
      continue;
    }
    unusableStops.add(s.stop_id);
    droppedStops++;
  }
  for (const s of stops) {
    if (s.parent_station && !allStopIds.has(s.parent_station)) {
      c.add('stops.fk_parent', 'warning', 'parent_station does not exist; cleared', s.stop_id, 'stops.txt');
    }
  }
  const cleanStops = stops.map((s) =>
    s.parent_station && !allStopIds.has(s.parent_station) ? { ...s, parent_station: null } : s,
  );

  // 3. Routes and agencies.
  const routes = [];
  const routeIds = new Set<string>();
  const seenRoutes = new Set<string>();
  for (const r of parsed.routes) {
    if (r.route_id === '' || r.route_type === null) {
      c.add('routes.missing_field', 'droppable', 'Route is missing route_id or has a non-integer route_type', r.route_id || '(blank id)', 'routes.txt');
      continue;
    }
    if (seenRoutes.has(r.route_id)) {
      c.add('routes.duplicate_id', 'fatal', 'route_id is not unique', r.route_id, 'routes.txt');
      continue;
    }
    seenRoutes.add(r.route_id);
    if (r.short_name === null && r.long_name === null) {
      c.add('routes.no_name', 'warning', 'Route has neither a short nor a long name', r.route_id, 'routes.txt');
    }
    routeIds.add(r.route_id);
    routes.push(r);
  }
  const agencyIds = new Set<string>();
  for (const a of parsed.agencies) {
    if (a.agency_name === '') c.add('agency.missing_field', 'warning', 'Agency has no name', a.agency_id ?? '(blank id)', 'agency.txt');
    if (a.agency_id !== null) {
      if (agencyIds.has(a.agency_id)) c.add('agency.duplicate_id', 'fatal', 'agency_id is not unique', a.agency_id, 'agency.txt');
      agencyIds.add(a.agency_id);
    }
  }
  const tz = parsed.agencies[0]?.agency_timezone;
  if (opts.expectedTimezone && tz && tz !== opts.expectedTimezone) {
    c.add('agency.timezone_mismatch', 'warning', `Agency timezone differs from expected ${opts.expectedTimezone}`, tz, 'agency.txt');
  }

  // 4. Calendars.
  const calendars = [];
  const serviceIds = new Set<string>();
  const seenServices = new Set<string>();
  for (const cal of parsed.calendars) {
    if (cal.service_id === '' || !cal.flags_valid || cal.start_date === null || cal.end_date === null || cal.end_date < cal.start_date) {
      c.add('calendar.invalid_row', 'droppable', 'Calendar row has bad flags/dates or ends before it starts', cal.service_id || '(blank id)', 'calendar.txt');
      continue;
    }
    if (seenServices.has(cal.service_id)) {
      c.add('calendar.duplicate_service_id', 'fatal', 'service_id is not unique in calendar.txt', cal.service_id, 'calendar.txt');
      continue;
    }
    seenServices.add(cal.service_id);
    serviceIds.add(cal.service_id);
    calendars.push(cal);
  }
  const calendarDates = new Map<string, (typeof parsed.calendarDates)[number]>();
  for (const cd of parsed.calendarDates) {
    if (cd.service_id === '' || cd.date === null || cd.exception_type === null) {
      c.add('calendar_dates.invalid_row', 'warning', 'calendar_dates row has a bad date/exception_type; dropped', cd.service_id || '(blank id)', 'calendar_dates.txt');
      continue;
    }
    const key = `${cd.service_id}\u0000${cd.date}`;
    if (calendarDates.has(key)) c.add('calendar_dates.duplicate', 'warning', 'Duplicate (service_id, date); last one wins', cd.service_id, 'calendar_dates.txt');
    calendarDates.set(key, cd);
    serviceIds.add(cd.service_id);
  }

  // 5. Trips.
  const shapeIds = new Set(parsed.shapes.map((s) => s.shape_id));
  const tripIdsInFile = new Set<string>();
  const candidateTrips = new Map<string, (typeof parsed.trips)[number]>();
  const dropTrips = new Set<string>();
  for (const t of parsed.trips) {
    if (t.trip_id === '' || t.route_id === '' || t.service_id === '') {
      c.add('trips.missing_field', 'droppable', 'Trip is missing trip_id, route_id or service_id', t.trip_id || '(blank id)', 'trips.txt');
      if (t.trip_id !== '') dropTrips.add(t.trip_id);
      else droppedBlankTrips++;
      continue;
    }
    if (tripIdsInFile.has(t.trip_id)) {
      c.add('trips.duplicate_id', 'fatal', 'trip_id is not unique', t.trip_id, 'trips.txt');
      continue;
    }
    tripIdsInFile.add(t.trip_id);
    if (!routeIds.has(t.route_id)) {
      c.add('trips.fk_route', 'droppable', 'Trip references a route_id that is not in routes.txt', t.trip_id, 'trips.txt');
      dropTrips.add(t.trip_id);
    } else if (!serviceIds.has(t.service_id)) {
      c.add('trips.fk_service', 'droppable', 'Trip references a service_id that is in neither calendar.txt nor calendar_dates.txt', t.trip_id, 'trips.txt');
      dropTrips.add(t.trip_id);
    } else if (t.shape_id !== null && !shapeIds.has(t.shape_id)) {
      c.add('trips.fk_shape', 'warning', 'Trip references a shape_id that has no points; shape cleared', t.trip_id, 'trips.txt');
      candidateTrips.set(t.trip_id, { ...t, shape_id: null });
    } else {
      candidateTrips.set(t.trip_id, t);
    }
  }

  // 6. Stop times, grouped per trip (file order is checked on purpose: GTFS consumers rely on it).
  const byTrip = new Map<string, GtfsStopTime[]>();
  for (const st of parsed.stopTimes) {
    let g = byTrip.get(st.trip_id);
    if (!g) byTrip.set(st.trip_id, (g = []));
    g.push(st);
  }
  let orphanRows = 0;
  const cleanStopTimes: GtfsStopTime[] = [];
  let filled = 0;
  for (const [tripId, rows] of byTrip) {
    if (!tripIdsInFile.has(tripId)) {
      orphanRows += rows.length;
      c.add('stop_times.fk_trip', 'droppable', 'stop_times rows reference a trip_id that is not in trips.txt', tripId, 'stop_times.txt', rows.length);
      continue;
    }
    if (dropTrips.has(tripId)) continue;
    const reason = tripProblem(rows, allStopIds, unusableStops);
    if (reason) {
      c.add(reason.rule, 'droppable', reason.message, tripId, 'stop_times.txt');
      dropTrips.add(tripId);
      continue;
    }
    filled += fillTimes(rows);
    cleanStopTimes.push(...rows);
  }
  for (const id of candidateTrips.keys()) {
    if (dropTrips.has(id)) continue;
    if (!byTrip.has(id)) {
      c.add('trips.too_few_stop_times', 'droppable', 'Trip has fewer than two stop_times', id, 'trips.txt');
      dropTrips.add(id);
    }
  }
  const cleanTrips = [...candidateTrips.values()].filter((t) => !dropTrips.has(t.trip_id));
  const droppedTripCount = dropTrips.size + droppedBlankTrips;
  const routesWithTrips = new Set(cleanTrips.map((t) => t.route_id));
  for (const r of routes) {
    if (!routesWithTrips.has(r.route_id)) c.add('routes.no_trips', 'warning', 'Route has no trips in the feed', r.short_name ?? r.route_id, 'routes.txt');
  }
  const survivingStopTimes = cleanStopTimes.filter((st) => !dropTrips.has(st.trip_id));

  // 7. Shapes.
  const shapes = [];
  const seenPts = new Set<string>();
  for (const p of parsed.shapes) {
    if (p.shape_id === '' || p.seq === null || p.lat === null || p.lon === null || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) {
      c.add('shapes.invalid_point', 'warning', 'Shape point has a bad coordinate or sequence; dropped', p.shape_id || '(blank id)', 'shapes.txt');
      continue;
    }
    const key = `${p.shape_id}\u0000${p.seq}`;
    if (seenPts.has(key)) {
      c.add('shapes.duplicate_point', 'warning', 'Duplicate (shape_id, shape_pt_sequence); dropped', p.shape_id, 'shapes.txt');
      continue;
    }
    seenPts.add(key);
    shapes.push(p);
  }

  const feed: ParsedGtfs = {
    ...parsed,
    stops: cleanStops,
    routes,
    trips: cleanTrips,
    stopTimes: survivingStopTimes,
    calendars,
    calendarDates: [...calendarDates.values()],
    shapes,
  };
  return finish(parsed, feed, c, opts, today, maxDrop, false, droppedStops, droppedTripCount, orphanRows, filled);
}

/** First problem found in one trip's stop_times (in file order), or null. */
function tripProblem(
  rows: GtfsStopTime[],
  allStopIds: Set<string>,
  unusableStops: Set<string>,
): { rule: string; message: string } | null {
  if (rows.length < 2) return { rule: 'trips.too_few_stop_times', message: 'Trip has fewer than two stop_times' };
  let prevSeq = -Infinity;
  for (const r of rows) {
    if (r.stop_sequence === null || r.stop_sequence < 0) {
      return { rule: 'stop_times.invalid_sequence', message: 'stop_sequence is blank, negative or not an integer' };
    }
    if (r.stop_sequence <= prevSeq) {
      return { rule: 'stop_times.sequence_not_increasing', message: 'stop_sequence is not strictly increasing within the trip' };
    }
    prevSeq = r.stop_sequence;
  }
  for (const r of rows) {
    if (!allStopIds.has(r.stop_id)) return { rule: 'stop_times.fk_stop', message: 'stop_times reference a stop_id that is not in stops.txt' };
    if (unusableStops.has(r.stop_id)) return { rule: 'stop_times.stop_unusable', message: 'Trip visits a stop that was dropped as invalid' };
  }
  if (rows.some((r) => r.time_invalid)) return { rule: 'stop_times.invalid_time', message: 'arrival_time/departure_time is not HH:MM:SS' };
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  for (const r of [first, last]) {
    if (r.arrival_sec === null && r.departure_sec === null) {
      return { rule: 'stop_times.missing_terminal_time', message: 'First and last stop_time of a trip must have a time' };
    }
  }
  let prev = -Infinity;
  for (const r of rows) {
    const arr = r.arrival_sec ?? r.departure_sec;
    const dep = r.departure_sec ?? r.arrival_sec;
    if (arr === null || dep === null) continue;
    if (arr > dep) return { rule: 'stop_times.arrival_after_departure', message: 'arrival_time is later than departure_time' };
    if (arr < prev) return { rule: 'stop_times.time_decreasing', message: 'Times go backwards along the trip' };
    prev = dep;
  }
  return null;
}

/** Copies the other of arrival/departure and interpolates remaining blanks by stop index. Mutates rows. */
function fillTimes(rows: GtfsStopTime[]): number {
  let filled = 0;
  for (const r of rows) {
    if (r.arrival_sec === null && r.departure_sec !== null) (r.arrival_sec = r.departure_sec), filled++;
    else if (r.departure_sec === null && r.arrival_sec !== null) (r.departure_sec = r.arrival_sec), filled++;
  }
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.arrival_sec !== null) {
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j]!.arrival_sec === null) j++;
    const a = rows[i - 1]!.departure_sec!;
    const b = rows[j]!.arrival_sec!;
    for (let k = i; k < j; k++) {
      const t = Math.round(a + ((b - a) * (k - i + 1)) / (j - i + 1));
      rows[k]!.arrival_sec = t;
      rows[k]!.departure_sec = t;
      filled++;
    }
    i = j;
  }
  return filled;
}

function finish(
  parsed: ParsedGtfs,
  feed: ParsedGtfs,
  c: Collector,
  opts: ValidationOptions,
  today: string,
  maxDrop: number,
  fatalStructure: boolean,
  droppedStops: number,
  droppedTrips: number,
  orphanRows: number,
  filled: number,
): PreparedGtfs {

  // Drop-threshold: too many row-level problems means the feed is broken, not just slightly dirty.
  const frac = (n: number, d: number) => (d > 0 ? n / d : 0);
  const exceeded: string[] = [];
  if (frac(droppedTrips, parsed.trips.length) > maxDrop) exceeded.push(`trips ${droppedTrips}/${parsed.trips.length}`);
  if (frac(droppedStops, parsed.stops.length) > maxDrop) exceeded.push(`stops ${droppedStops}/${parsed.stops.length}`);
  if (frac(orphanRows, parsed.stopTimes.length) > maxDrop) exceeded.push(`orphan stop_times ${orphanRows}/${parsed.stopTimes.length}`);
  if (!fatalStructure) {
    if (exceeded.length) {
      c.add('rows.drop_threshold_exceeded', 'fatal', `Too many invalid rows dropped (limit ${(maxDrop * 100).toFixed(1)}%): ${exceeded.join(', ')}`, exceeded[0]);
    }
    if (feed.trips.length === 0) c.add('feed.empty_after_cleaning', 'fatal', 'No valid trips remain after dropping invalid rows');
  }

  // Service window and future service, judged on what will actually be loaded.
  let calStart: string | null = null;
  let calEnd: string | null = null;
  if (!fatalStructure) {
    const used = new Set(feed.trips.map((t) => t.service_id));
    for (const cal of feed.calendars) {
      if (!used.has(cal.service_id) || cal.start_date === null || cal.end_date === null) continue;
      if (calStart === null || cal.start_date < calStart) calStart = cal.start_date;
      if (calEnd === null || cal.end_date > calEnd) calEnd = cal.end_date;
    }
    for (const cd of feed.calendarDates) {
      if (!used.has(cd.service_id) || cd.exception_type !== 1 || cd.date === null) continue;
      if (calStart === null || cd.date < calStart) calStart = cd.date;
      if (calEnd === null || cd.date > calEnd) calEnd = cd.date;
    }
    if (feed.trips.length > 0) {
      const soon = opts.expiringSoonDays ?? 14;
      if (calEnd === null || calEnd < today) {
        c.add('calendar.no_future_service', 'fatal', `No trip has service on or after ${today} (latest service day: ${calEnd ?? 'none'})`, calEnd ?? 'none', 'calendar.txt');
      } else if (calEnd < addDays(today, soon)) {
        c.add('calendar.expiring_soon', 'warning', `Service ends within ${soon} days`, calEnd, 'calendar.txt');
      }
    }
    const fiEnd = parsed.feedInfo?.end_date;
    if (fiEnd && fiEnd < today) c.add('feed_info.expired', 'warning', 'feed_info feed_end_date is in the past', fiEnd, 'feed_info.txt');
  }

  const counts: FeedCounts = fatalStructure
    ? {
        ...emptyCounts(),
        agencies: parsed.agencies.length,
        stops: parsed.stops.length,
        routes: parsed.routes.length,
        trips: parsed.trips.length,
        stop_times: parsed.stopTimes.length,
        calendars: parsed.calendars.length,
        calendar_dates: parsed.calendarDates.length,
        shape_points: parsed.shapes.length,
      }
    : {
        agencies: feed.agencies.length,
        stops: feed.stops.length,
        routes: feed.routes.length,
        trips: feed.trips.length,
        stop_times: feed.stopTimes.length,
        calendars: feed.calendars.length,
        calendar_dates: feed.calendarDates.length,
        shape_points: feed.shapes.length,
      };

  // Count-change band against the previous version.
  let needsReview = false;
  const band = opts.countChangeBand ?? 0.5;
  if (opts.previousCounts && !fatalStructure) {
    for (const k of ['routes', 'stops', 'trips'] as const) {
      const prev = opts.previousCounts[k];
      if (!prev || prev <= 0) continue;
      const change = (counts[k] - prev) / prev;
      if (Math.abs(change) > band) {
        needsReview = true;
        c.add('counts.band_exceeded', 'warning', `Entity count changed by more than ${(band * 100).toFixed(0)}% versus the previous version; needs review`, `${k}: ${prev} -> ${counts[k]} (${(change * 100).toFixed(0)}%)`);
      }
    }
  }

  const failedThreshold = c.map.has('rows.drop_threshold_exceeded') || c.map.has('feed.empty_after_cleaning');
  const issues: ValidationIssue[] = [];
  for (const [rule, a] of c.map) {
    const severity: Severity = a.kind === 'fatal' || (a.kind === 'droppable' && failedThreshold) ? 'error' : 'warning';
    issues.push({ rule, severity, ...(a.file ? { file: a.file } : {}), message: a.message, count: a.count, samples: a.samples });
  }
  issues.sort((x, y) => (x.severity === y.severity ? x.rule.localeCompare(y.rule) : x.severity === 'error' ? -1 : 1));
  const errors = issues.filter((i) => i.severity === 'error').length;

  return {
    feed,
    report: {
      acceptable: errors === 0,
      needs_review: needsReview,
      errors,
      warnings: issues.length - errors,
      issues,
      counts,
      row_counts: parsed.rowCounts,
      dropped: { stops: droppedStops, trips: droppedTrips, orphan_stop_times: orphanRows },
      filled_stop_times: filled,
      calendar_start: calStart,
      calendar_end: calEnd,
      checked_on: today,
    },
  };
}

/** Report for an archive that could not even be parsed (truncated, garbage, zip bomb). Always unacceptable. */
export function reportForParseError(err: { code: string; message: string }, opts: ValidationOptions = {}): ValidationReport {
  return {
    acceptable: false,
    needs_review: false,
    errors: 1,
    warnings: 0,
    issues: [{ rule: `zip.${err.code.replace(/^zip_/, '')}`, severity: 'error', message: err.message, count: 1, samples: [] }],
    counts: emptyCounts(),
    row_counts: {},
    dropped: { stops: 0, trips: 0, orphan_stop_times: 0 },
    filled_stop_times: 0,
    calendar_start: null,
    calendar_end: null,
    checked_on: opts.today ?? colomboDate((opts.clock ?? systemClock).now()),
  };
}
