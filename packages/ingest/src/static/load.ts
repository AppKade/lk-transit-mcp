import type { Db } from '@lkt/core';
import type { ParsedGtfs } from '@lkt/gtfs';

type Cell = string | number | boolean | null;

/** Parameterised multi-row INSERT in batches (Postgres allows 65535 bind parameters per statement). */
export async function bulkInsert(
  db: Db,
  table: string,
  columns: string[],
  rows: Cell[][],
  batchRows = 1000,
): Promise<void> {
  const size = Math.max(1, Math.min(batchRows, Math.floor(30_000 / columns.length)));
  for (let i = 0; i < rows.length; i += size) {
    const params: Cell[] = [];
    const tuples = rows.slice(i, i + size).map(
      (r) => `(${r.map((v) => (params.push(v), `$${params.length}`)).join(',')})`,
    );
    await db.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`, params);
  }
}

/** Writes every table of a cleaned feed under `fv`. Not transactional on purpose: the version stays 'staged' until activation. */
export async function loadFeed(db: Db, fv: number, f: ParsedGtfs): Promise<void> {
  await bulkInsert(
    db,
    'stops',
    ['feed_version_id', 'stop_id', 'name', 'lat', 'lon', 'code', 'description', 'zone_id', 'location_type', 'parent_station', 'wheelchair_boarding'],
    f.stops.map((s) => [fv, s.stop_id, s.stop_name, s.lat!, s.lon!, s.code, s.desc, s.zone_id, s.location_type, s.parent_station, s.wheelchair_boarding]),
  );
  await bulkInsert(
    db,
    'routes',
    ['feed_version_id', 'route_id', 'agency_id', 'short_name', 'long_name', 'route_type', 'color', 'text_color'],
    f.routes.map((r) => [fv, r.route_id, r.agency_id, r.short_name, r.long_name, r.route_type!, r.color, r.text_color]),
  );
  await bulkInsert(
    db,
    'calendars',
    ['feed_version_id', 'service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
    f.calendars.map((c) => [fv, c.service_id, c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday, c.sunday, c.start_date!, c.end_date!]),
  );
  await bulkInsert(
    db,
    'calendar_dates',
    ['feed_version_id', 'service_id', 'date', 'exception_type'],
    f.calendarDates.map((c) => [fv, c.service_id, c.date!, c.exception_type!]),
  );
  await bulkInsert(
    db,
    'trips',
    ['feed_version_id', 'trip_id', 'route_id', 'service_id', 'headsign', 'short_name', 'direction_id', 'shape_id', 'wheelchair_accessible'],
    f.trips.map((t) => [fv, t.trip_id, t.route_id, t.service_id, t.headsign, t.short_name, t.direction_id, t.shape_id, t.wheelchair_accessible]),
  );
  await bulkInsert(
    db,
    'stop_times',
    ['feed_version_id', 'trip_id', 'stop_sequence', 'stop_id', 'arrival_sec', 'departure_sec', 'pickup_type', 'drop_off_type'],
    f.stopTimes.map((s) => [fv, s.trip_id, s.stop_sequence!, s.stop_id, s.arrival_sec, s.departure_sec, s.pickup_type, s.drop_off_type]),
  );
  await bulkInsert(
    db,
    'shapes',
    ['feed_version_id', 'shape_id', 'seq', 'lat', 'lon'],
    f.shapes.map((p) => [fv, p.shape_id, p.seq!, p.lat!, p.lon!]),
  );
}
