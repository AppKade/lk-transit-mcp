import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { LMT, emptySnapshot } from '@lkt/core';
import type {
  Clock, Db, FeedState, RealtimeFeedKey, RealtimeSnapshot, RealtimeSource, Resolution, RtAlert, RtStopTimeUpdate,
  RtTripUpdate, RtVehicle,
} from '@lkt/core';
import { createPgliteDb, migrate } from '@lkt/db';
import { createTransitQueries } from '../src/index.js';
import type { TransitQueries } from '../src/index.js';

const GTFS_ZIP = new URL('../../../fixtures/lmt/gtfs.zip', import.meta.url);

/** Minimal zip reader (central directory + raw inflate); enough for the fixture, avoids a test-only dependency. */
function unzip(buf: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    files.set(name, (method === 8 ? inflateRawSync(raw) : raw).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries((head ?? []).map((h, i) => [h, r[i] ?? ''])));
}

const gtfsSec = (t: string): number | null => {
  const m = /^(\d+):(\d\d):(\d\d)$/.exec(t.trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
};
const nul = (v: string | undefined): string | null => (v === undefined || v === '' ? null : v);
const int = (v: string | undefined): number | null => (nul(v) === null ? null : Number(v));
const isoDate = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

async function insertRows(db: Db, table: string, columns: string[], rows: unknown[][], batch = 400): Promise<void> {
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const params: unknown[] = [];
    const tuples = chunk.map((r) => `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(',')})`);
    await db.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`, params);
  }
}

export const ROUTE_UUID = {
  CM01: '8bc594e3-8ad6-4a0d-9138-bf8b4247e2f5',
  CM02: 'f3eaf277-a6fa-4f5b-8a61-3b1758d9a4b8',
  CM03: 'c0030000-0000-4000-8000-000000000003',
  CM08: 'c0080000-0000-4000-8000-000000000008',
} as const;

export const FEED_LABEL = '2026-10-20T03:00Z-test01';

export interface SeedOptions {
  /** Adds an after-midnight trip (24:10 at stops 1-3, route CM01) and a one-day special service via calendar_dates. */
  extras?: boolean;
  calendarEnd?: string;
  activatedAtMs?: number;
}

export async function seedLmt(db: Db, opts: SeedOptions = {}): Promise<number> {
  const zip = unzip(readFileSync(GTFS_ZIP));
  const csv = (name: string) => parseCsv(zip.get(`${name}.txt`) ?? '');
  const calendars = csv('calendar');
  const trips = csv('trips');
  const stopTimes = csv('stop_times');
  const calendarEnd = opts.calendarEnd ?? isoDate(calendars[0]?.['end_date'] ?? '20271231');

  await db.query(`INSERT INTO providers (id, name, timezone) VALUES ($1, $2, $3)`, [LMT.id, LMT.name, LMT.timezone]);
  const fv = await db.query<{ id: number }>(
    `INSERT INTO feed_versions (provider_id, status, checksum, label, source_key, fetched_at, activated_at, calendar_start, calendar_end, counts)
     VALUES ($1, 'active', 'abc123', $2, 'lmt.gtfs', $3, $3, '2026-01-01', $4, $5) RETURNING id`,
    [LMT.id, FEED_LABEL, new Date(opts.activatedAtMs ?? Date.UTC(2026, 9, 20, 0, 0, 0)).toISOString(), calendarEnd,
      JSON.stringify({ stops: csv('stops').length, routes: csv('routes').length, trips: trips.length, stop_times: stopTimes.length })],
  );
  const id = Number(fv.rows[0]!.id);
  await db.query(`UPDATE providers SET active_feed_version_id = $1 WHERE id = $2`, [id, LMT.id]);

  await insertRows(db, 'stops', ['feed_version_id', 'stop_id', 'name', 'lat', 'lon', 'code', 'location_type'],
    csv('stops').map((s) => [id, s['stop_id'], s['stop_name'], Number(s['stop_lat']), Number(s['stop_lon']), nul(s['stop_code']), int(s['location_type']) ?? 0]));
  await insertRows(db, 'routes', ['feed_version_id', 'route_id', 'agency_id', 'short_name', 'long_name', 'route_type', 'color', 'text_color'],
    csv('routes').map((r) => [id, r['route_id'], nul(r['agency_id']), nul(r['route_short_name']), nul(r['route_long_name']), int(r['route_type']) ?? 3, nul(r['route_color']), nul(r['route_text_color'])]));
  await insertRows(db, 'trips', ['feed_version_id', 'trip_id', 'route_id', 'service_id', 'headsign', 'direction_id'],
    trips.map((t) => [id, t['trip_id'], t['route_id'], t['service_id'], nul(t['trip_headsign']), int(t['direction_id'])]));
  await insertRows(db, 'stop_times', ['feed_version_id', 'trip_id', 'stop_sequence', 'stop_id', 'arrival_sec', 'departure_sec'],
    stopTimes.map((s) => [id, s['trip_id'], Number(s['stop_sequence']), s['stop_id'], gtfsSec(s['arrival_time'] ?? ''), gtfsSec(s['departure_time'] ?? '')]));
  await insertRows(db, 'calendars', ['feed_version_id', 'service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
    calendars.map((c) => [id, c['service_id'], ...['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => c[d] === '1'), isoDate(c['start_date']!), isoDate(c['end_date']!)]));

  if (opts.extras) {
    const cm01 = ROUTE_UUID.CM01;
    await insertRows(db, 'calendars', ['feed_version_id', 'service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
      [[id, 'SERV_SPECIAL', false, false, false, false, false, false, false, '2026-01-01', '2027-12-31']]);
    await insertRows(db, 'trips', ['feed_version_id', 'trip_id', 'route_id', 'service_id', 'headsign', 'direction_id'], [
      [id, 'TRIP_CM01_NIGHT', cm01, 'SERV_LMT_DAILY', 'Night owl', 0],
      [id, 'TRIP_CM01_SPECIAL', cm01, 'SERV_SPECIAL', 'Special', 0],
    ]);
    await insertRows(db, 'stop_times', ['feed_version_id', 'trip_id', 'stop_sequence', 'stop_id', 'arrival_sec', 'departure_sec'], [
      [id, 'TRIP_CM01_NIGHT', 1, '1', 24 * 3600 + 600, 24 * 3600 + 600],
      [id, 'TRIP_CM01_NIGHT', 2, '2', 24 * 3600 + 780, 24 * 3600 + 780],
      [id, 'TRIP_CM01_NIGHT', 3, '3', 24 * 3600 + 960, 24 * 3600 + 960],
      [id, 'TRIP_CM01_SPECIAL', 1, '1', 9 * 3600 + 300, 9 * 3600 + 300],
      [id, 'TRIP_CM01_SPECIAL', 2, '2', 9 * 3600 + 480, 9 * 3600 + 480],
    ]);
    await insertRows(db, 'calendar_dates', ['feed_version_id', 'service_id', 'date', 'exception_type'], [
      [id, 'SERV_SPECIAL', '2026-10-20', 1], // one-day addition
      [id, 'SERV_LMT_DAILY', '2026-10-22', 2], // holiday: the regular service does not run
    ]);
  }
  return id;
}

export async function setupDb(opts: SeedOptions = {}): Promise<Db & { close(): Promise<void> }> {
  const db = await createPgliteDb();
  await migrate(db);
  await seedLmt(db, opts);
  return db;
}

// ---------- clock, realtime fakes ----------

/** 2026-10-20 (Tuesday) 06:25:00 Asia/Colombo: five minutes before the first 06:30 departures. */
export const NOW = Date.UTC(2026, 9, 20, 0, 55, 0);
/** 2026-10-21 00:05:00 Asia/Colombo, just after midnight. */
export const AFTER_MIDNIGHT = Date.UTC(2026, 9, 20, 18, 35, 0);

export function fixedClock(ms: number): Clock & { set(ms: number): void } {
  let t = ms;
  return { now: () => t, set: (v) => { t = v; } };
}

export class FakeRealtime implements RealtimeSource {
  snapshot: RealtimeSnapshot = emptySnapshot('lmt');
  failing = false;
  async getSnapshot(): Promise<RealtimeSnapshot> {
    if (this.failing) throw new Error('hub down');
    return this.snapshot;
  }
}

export function feed(headerMs: number | null, extra: Partial<FeedState> = {}): FeedState {
  return {
    ok: headerMs !== null, last_attempt_ms: headerMs, last_success_ms: headerMs, header_timestamp_ms: headerMs,
    entity_count: 0, quarantined_count: 0, consecutive_failures: 0, last_error: null, ...extra,
  };
}

export function snapshotOf(parts: Partial<Omit<RealtimeSnapshot, 'provider'>>, feeds: Partial<Record<RealtimeFeedKey, FeedState>> = {}): RealtimeSnapshot {
  const base = emptySnapshot('lmt');
  return { ...base, ...parts, feeds: { ...base.feeds, ...feeds } };
}

export const resolved = (route_id: string | null, direction_id: number | null): Resolution => ({
  route_id, direction_id, static_trip_id: null, method: route_id ? 'route_short_name' : 'unresolved',
});

export function stu(stop_id: string, timeMs: number, delay: number | null = null): RtStopTimeUpdate {
  return {
    stop_sequence: null, stop_id, arrival_time_ms: timeMs, arrival_delay_s: delay, departure_time_ms: timeMs,
    departure_delay_s: delay, schedule_relationship: 'SCHEDULED',
  };
}

export function tripUpdate(o: { id: string; route: string | null; dir: number | null; observed: number; vehicle?: string; updates: RtStopTimeUpdate[] }): RtTripUpdate {
  return {
    entity_id: o.id, trip_id: `LMT_RT_${o.id}`, route_id_raw: 'CM01', direction_id: o.dir, start_date: null,
    vehicle_id: o.vehicle ?? null, schedule_relationship: 'SCHEDULED', observed_at_ms: o.observed,
    stop_time_updates: o.updates, resolution: resolved(o.route, o.dir),
  };
}

export function vehicle(o: Partial<RtVehicle> & { entity_id: string; observed_at_ms: number }): RtVehicle {
  return {
    vehicle_id: o.entity_id, label: null, license_plate: null, trip_id: null, route_id_raw: 'CM01', direction_id: 0,
    latitude: 6.93, longitude: 79.85, bearing: null, speed_mps: null, current_stop_id: null, current_status: null,
    occupancy_status: null, occupancy_percentage: null, resolution: resolved(ROUTE_UUID.CM01, 0), ...o,
  };
}

export function alert(o: Partial<RtAlert> & { entity_id: string }): RtAlert {
  return {
    cause: null, effect: null, header: o.entity_id, description: null, url: null, active_periods: [],
    informed_entities: [], observed_at_ms: NOW, ...o,
  };
}

export interface Harness {
  q: TransitQueries;
  rt: FakeRealtime;
  clock: ReturnType<typeof fixedClock>;
}

export function harness(db: Db, nowMs = NOW): Harness {
  const rt = new FakeRealtime();
  const clock = fixedClock(nowMs);
  const q = createTransitQueries({ db, realtime: rt, clock, providers: { lmt: LMT }, defaultProvider: 'lmt' });
  return { q, rt, clock };
}
