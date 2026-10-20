import { unzipSync } from 'fflate';
import Papa from 'papaparse';
import { normalizeServiceDate, parseGtfsTime } from '@lkt/core';
import type {
  GtfsAgency,
  GtfsCalendar,
  GtfsCalendarDate,
  GtfsFeedInfo,
  GtfsFileInfo,
  GtfsRoute,
  GtfsShapePoint,
  GtfsStop,
  GtfsStopTime,
  GtfsTrip,
  ParsedGtfs,
} from './types.js';

export class GtfsParseError extends Error {
  constructor(
    readonly code: 'zip_invalid' | 'zip_too_large' | 'zip_empty',
    message: string,
  ) {
    super(message);
    this.name = 'GtfsParseError';
  }
}

export interface ParseOptions {
  /** Reject archives whose files would inflate beyond this many bytes in total (zip-bomb guard). Default 300 MB. */
  maxUncompressedBytes?: number;
}

const KNOWN = new Set([
  'agency.txt',
  'stops.txt',
  'routes.txt',
  'trips.txt',
  'stop_times.txt',
  'calendar.txt',
  'calendar_dates.txt',
  'shapes.txt',
  'feed_info.txt',
]);

type Row = Record<string, string | undefined>;

function readCsv(text: string): { columns: string[]; rows: Row[] } {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const res = Papa.parse<Row>(clean, {
    header: true,
    delimiter: ',',
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.replace(/^﻿/, '').trim().toLowerCase(),
    transform: (v) => v.trim(),
  });
  return { columns: res.meta.fields ?? [], rows: res.data };
}

const str = (r: Row, k: string): string => r[k] ?? '';
const opt = (r: Row, k: string): string | null => {
  const v = r[k];
  return v === undefined || v === '' ? null : v;
};
const int = (r: Row, k: string): number | null => {
  const v = r[k];
  return v !== undefined && /^-?\d+$/.test(v) ? Number(v) : null;
};
const num = (r: Row, k: string): number | null => {
  const v = r[k];
  if (v === undefined || v === '' || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v)) return null;
  return Number(v);
};
const date = (r: Row, k: string): string | null => {
  const v = r[k];
  return v ? normalizeServiceDate(v) : null;
};

function time(r: Row, k: string): { sec: number | null; invalid: boolean } {
  const v = r[k];
  if (v === undefined || v === '') return { sec: null, invalid: false };
  const sec = parseGtfsTime(v);
  return { sec, invalid: sec === null };
}

const flag = (r: Row, k: string): boolean | null => {
  const v = r[k];
  return v === '1' ? true : v === '0' ? false : null;
};

/**
 * Unzips and parses a GTFS Schedule archive. Runs on Workers: only fflate, papaparse and TextDecoder.
 * Throws GtfsParseError for a corrupt/oversized archive; every other problem is left for validateGtfs to report.
 */
export function parseGtfsZip(bytes: Uint8Array, opts: ParseOptions = {}): ParsedGtfs {
  const maxTotal = opts.maxUncompressedBytes ?? 300 * 1024 * 1024;
  const ignored: string[] = [];
  let inflatedTotal = 0;
  let tooLarge = false;

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        const name = baseName(f.name);
        if (f.name.endsWith('/') || name === '') return false;
        if (!KNOWN.has(name)) {
          ignored.push(name);
          return false;
        }
        inflatedTotal += f.originalSize;
        if (inflatedTotal > maxTotal) tooLarge = true;
        return !tooLarge;
      },
    });
  } catch (e) {
    throw new GtfsParseError('zip_invalid', `not a readable zip archive: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (tooLarge) throw new GtfsParseError('zip_too_large', `archive inflates beyond ${maxTotal} bytes`);

  const decoder = new TextDecoder('utf-8');
  const tables = new Map<string, { columns: string[]; rows: Row[] }>();
  for (const [path, data] of Object.entries(entries)) tables.set(baseName(path), readCsv(decoder.decode(data)));
  if (tables.size === 0 && ignored.length === 0) throw new GtfsParseError('zip_empty', 'archive contains no files');

  const files: Record<string, GtfsFileInfo> = {};
  const rowCounts: Record<string, number> = {};
  for (const [name, t] of tables) {
    files[name] = { rows: t.rows.length, columns: t.columns };
    rowCounts[name] = t.rows.length;
  }
  const rows = (name: string): Row[] => tables.get(name)?.rows ?? [];

  const agencies: GtfsAgency[] = rows('agency.txt').map((r) => ({
    agency_id: opt(r, 'agency_id'),
    agency_name: str(r, 'agency_name'),
    agency_url: opt(r, 'agency_url'),
    agency_timezone: opt(r, 'agency_timezone'),
    agency_lang: opt(r, 'agency_lang'),
  }));

  const stops: GtfsStop[] = rows('stops.txt').map((r) => ({
    stop_id: str(r, 'stop_id'),
    stop_name: str(r, 'stop_name'),
    lat: num(r, 'stop_lat'),
    lon: num(r, 'stop_lon'),
    code: opt(r, 'stop_code'),
    desc: opt(r, 'stop_desc'),
    zone_id: opt(r, 'zone_id'),
    location_type: int(r, 'location_type') ?? 0,
    parent_station: opt(r, 'parent_station'),
    wheelchair_boarding: int(r, 'wheelchair_boarding'),
  }));

  const routes: GtfsRoute[] = rows('routes.txt').map((r) => ({
    route_id: str(r, 'route_id'),
    agency_id: opt(r, 'agency_id'),
    short_name: opt(r, 'route_short_name'),
    long_name: opt(r, 'route_long_name'),
    route_type: int(r, 'route_type'),
    color: opt(r, 'route_color'),
    text_color: opt(r, 'route_text_color'),
  }));

  const trips: GtfsTrip[] = rows('trips.txt').map((r) => ({
    trip_id: str(r, 'trip_id'),
    route_id: str(r, 'route_id'),
    service_id: str(r, 'service_id'),
    headsign: opt(r, 'trip_headsign'),
    short_name: opt(r, 'trip_short_name'),
    direction_id: int(r, 'direction_id'),
    shape_id: opt(r, 'shape_id'),
    wheelchair_accessible: int(r, 'wheelchair_accessible'),
  }));

  const stopTimes: GtfsStopTime[] = rows('stop_times.txt').map((r) => {
    const a = time(r, 'arrival_time');
    const d = time(r, 'departure_time');
    return {
      trip_id: str(r, 'trip_id'),
      stop_id: str(r, 'stop_id'),
      stop_sequence: int(r, 'stop_sequence'),
      arrival_sec: a.sec,
      departure_sec: d.sec,
      time_invalid: a.invalid || d.invalid,
      pickup_type: int(r, 'pickup_type'),
      drop_off_type: int(r, 'drop_off_type'),
    };
  });

  const calendars: GtfsCalendar[] = rows('calendar.txt').map((r) => {
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => flag(r, d));
    return {
      service_id: str(r, 'service_id'),
      monday: days[0] === true,
      tuesday: days[1] === true,
      wednesday: days[2] === true,
      thursday: days[3] === true,
      friday: days[4] === true,
      saturday: days[5] === true,
      sunday: days[6] === true,
      start_date: date(r, 'start_date'),
      end_date: date(r, 'end_date'),
      flags_valid: days.every((d) => d !== null),
    };
  });

  const calendarDates: GtfsCalendarDate[] = rows('calendar_dates.txt').map((r) => {
    const t = int(r, 'exception_type');
    return {
      service_id: str(r, 'service_id'),
      date: date(r, 'date'),
      exception_type: t === 1 || t === 2 ? t : null,
    };
  });

  const shapes: GtfsShapePoint[] = rows('shapes.txt').map((r) => ({
    shape_id: str(r, 'shape_id'),
    lat: num(r, 'shape_pt_lat'),
    lon: num(r, 'shape_pt_lon'),
    seq: int(r, 'shape_pt_sequence'),
  }));

  const fi = rows('feed_info.txt')[0];
  const feedInfo: GtfsFeedInfo | null = fi
    ? {
        publisher_name: opt(fi, 'feed_publisher_name'),
        publisher_url: opt(fi, 'feed_publisher_url'),
        lang: opt(fi, 'feed_lang'),
        start_date: date(fi, 'feed_start_date'),
        end_date: date(fi, 'feed_end_date'),
        version: opt(fi, 'feed_version'),
      }
    : null;

  return {
    agencies,
    stops,
    routes,
    trips,
    stopTimes,
    calendars,
    calendarDates,
    shapes,
    feedInfo,
    files,
    rowCounts,
    ignoredFiles: [...new Set(ignored)].sort(),
  };
}

/** Archives sometimes nest the feed in a folder; only the lower-cased basename matters. */
function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return (i >= 0 ? path.slice(i + 1) : path).toLowerCase();
}
