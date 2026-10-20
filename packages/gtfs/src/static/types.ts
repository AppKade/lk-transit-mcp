/**
 * Parsed (not yet validated) GTFS Schedule tables. Required string fields are '' when blank; optional ones are null.
 * Numeric fields that failed to parse are null so the validator can tell "absent" from "present".
 */

export interface GtfsAgency {
  agency_id: string | null;
  agency_name: string;
  agency_url: string | null;
  agency_timezone: string | null;
  agency_lang: string | null;
}

export interface GtfsStop {
  stop_id: string;
  stop_name: string;
  lat: number | null;
  lon: number | null;
  code: string | null;
  desc: string | null;
  zone_id: string | null;
  location_type: number;
  parent_station: string | null;
  wheelchair_boarding: number | null;
}

export interface GtfsRoute {
  route_id: string;
  agency_id: string | null;
  short_name: string | null;
  long_name: string | null;
  route_type: number | null;
  color: string | null;
  text_color: string | null;
}

export interface GtfsTrip {
  trip_id: string;
  route_id: string;
  service_id: string;
  headsign: string | null;
  short_name: string | null;
  direction_id: number | null;
  shape_id: string | null;
  wheelchair_accessible: number | null;
}

export interface GtfsStopTime {
  trip_id: string;
  stop_id: string;
  /** null when blank or not an integer. */
  stop_sequence: number | null;
  /** Seconds since service-day start; may exceed 86400. null when blank or malformed. */
  arrival_sec: number | null;
  departure_sec: number | null;
  /** True when an arrival/departure value was present but malformed. */
  time_invalid: boolean;
  pickup_type: number | null;
  drop_off_type: number | null;
}

export interface GtfsCalendar {
  service_id: string;
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
  /** "YYYY-MM-DD"; null when malformed. */
  start_date: string | null;
  end_date: string | null;
  /** False when a weekday flag was not 0/1. */
  flags_valid: boolean;
}

export interface GtfsCalendarDate {
  service_id: string;
  date: string | null;
  exception_type: 1 | 2 | null;
}

export interface GtfsShapePoint {
  shape_id: string;
  lat: number | null;
  lon: number | null;
  seq: number | null;
}

export interface GtfsFeedInfo {
  publisher_name: string | null;
  publisher_url: string | null;
  lang: string | null;
  start_date: string | null;
  end_date: string | null;
  version: string | null;
}

export interface GtfsFileInfo {
  rows: number;
  columns: string[];
}

export interface ParsedGtfs {
  agencies: GtfsAgency[];
  stops: GtfsStop[];
  routes: GtfsRoute[];
  trips: GtfsTrip[];
  stopTimes: GtfsStopTime[];
  calendars: GtfsCalendar[];
  calendarDates: GtfsCalendarDate[];
  shapes: GtfsShapePoint[];
  feedInfo: GtfsFeedInfo | null;
  /** Known files present in the zip (basename, lower case) with row counts and header columns. */
  files: Record<string, GtfsFileInfo>;
  /** Row count per known file, e.g. { "stops.txt": 219 }. */
  rowCounts: Record<string, number>;
  /** Other files in the zip that are deliberately not parsed (fare tables etc.). */
  ignoredFiles: string[];
}

export type FeedCounts = {
  agencies: number;
  stops: number;
  routes: number;
  trips: number;
  stop_times: number;
  calendars: number;
  calendar_dates: number;
  shape_points: number;
};

export type Severity = 'error' | 'warning';

export interface ValidationIssue {
  /** Stable rule id, e.g. `stop_times.sequence_not_increasing`. */
  rule: string;
  severity: Severity;
  file?: string;
  message: string;
  /** Number of offending entities / rows. */
  count: number;
  /** Up to `sampleSize` offending ids. */
  samples: string[];
}

export interface ValidationReport {
  /** True iff there are zero errors. */
  acceptable: boolean;
  /** True when a count-change band was exceeded: usable, but a human should look. */
  needs_review: boolean;
  errors: number;
  warnings: number;
  issues: ValidationIssue[];
  /** Counts of what would be loaded (after dropping bad rows). */
  counts: FeedCounts;
  /** Raw row counts per file as parsed. */
  row_counts: Record<string, number>;
  dropped: { stops: number; trips: number; orphan_stop_times: number };
  /** Stop times whose blank times were filled in (copy or interpolation). */
  filled_stop_times: number;
  calendar_start: string | null;
  calendar_end: string | null;
  /** Colombo date used as "today" for the future-service check. */
  checked_on: string;
}
