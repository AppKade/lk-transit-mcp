import { describe, expect, it } from 'vitest';
import { GtfsParseError, parseGtfsZip, prepareGtfs, reportForParseError, validateGtfs } from '../../src/static/index.js';
import type { ValidationOptions, ValidationReport } from '../../src/static/index.js';
import { TODAY, editTable, fixtureBytes, fixtureFiles, fixtureWith, readTable, without } from './helpers.js';
import type { Files, Table } from './helpers.js';

const opts: ValidationOptions = { today: TODAY };
const validate = (bytes: Uint8Array, o: ValidationOptions = opts) => validateGtfs(parseGtfsZip(bytes), o);
const rules = (r: ValidationReport, severity?: 'error' | 'warning') =>
  r.issues.filter((i) => !severity || i.severity === severity).map((i) => i.rule);

/** Rewrites the stop_times of the first `n` trips with `fn(rows of that trip)`. */
const breakTrips = (n: number, fn: (rows: Table) => void) => (f: Files) =>
  editTable(f, 'stop_times.txt', (rows) => {
    const ids = [...new Set(rows.map((r) => r.trip_id))].slice(0, n);
    for (const id of ids) fn(rows.filter((r) => r.trip_id === id));
  });

describe('validateGtfs: real fixture', () => {
  it('is acceptable, with only the known unserved-route warning', () => {
    const r = validate(fixtureBytes());
    expect(r.acceptable).toBe(true);
    expect(r.errors).toBe(0);
    expect(r.needs_review).toBe(false);
    expect(r.issues.map((i) => [i.rule, i.severity, i.samples])).toEqual([['routes.no_trips', 'warning', ['CM06']]]);
    expect(r.counts).toMatchObject({ routes: 7, stops: 220, trips: 56, stop_times: 1092, shape_points: 12393 });
    expect(r.calendar_start).toBe('2026-01-01');
    expect(r.calendar_end).toBe('2027-12-31');
    expect(r.dropped).toEqual({ stops: 0, trips: 0, orphan_stop_times: 0 });
  });

  it('is JSON-serialisable and uses the injected clock', () => {
    const r = validateGtfs(parseGtfsZip(fixtureBytes()), { clock: { now: () => Date.parse('2026-10-20T10:00:00Z') } });
    expect(r.checked_on).toBe('2026-10-20');
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

describe('validateGtfs: structural errors', () => {
  it('flags a missing required file', () => {
    const r = validate(fixtureWith(without('stop_times.txt')));
    expect(r.acceptable).toBe(false);
    expect(r.issues.find((i) => i.rule === 'file.missing')).toMatchObject({ severity: 'error', samples: ['stop_times.txt'] });
  });

  it('requires calendar.txt or calendar_dates.txt', () => {
    const r = validate(fixtureWith(without('calendar.txt')));
    expect(rules(r, 'error')).toContain('file.missing');
    expect(r.issues[0]!.samples).toEqual(['calendar.txt|calendar_dates.txt']);
  });

  it('accepts calendar_dates.txt as the only service definition', () => {
    const r = validate(
      fixtureWith(without('calendar.txt'), (f) => ({
        ...f,
        'calendar_dates.txt': 'service_id,date,exception_type\nSERV_LMT_DAILY,20271201,1\nSERV_LMT_DAILY,20271202,1\n',
      })),
    );
    expect(r.acceptable).toBe(true);
    expect(r.calendar_end).toBe('2027-12-02');
  });

  it('flags a missing required column', () => {
    const r = validate(fixtureWith((f) => ({ ...f, 'stops.txt': f['stops.txt']!.replace('stop_lat', 'latitude') })));
    expect(r.issues.find((i) => i.rule === 'column.missing')).toMatchObject({ severity: 'error', samples: ['stops.txt:stop_lat'] });
  });

  it('flags an empty core file', () => {
    const r = validate(fixtureWith((f) => ({ ...f, 'trips.txt': f['trips.txt']!.split('\n', 1)[0]! + '\n' })));
    expect(rules(r, 'error')).toContain('file.empty');
  });

  it('flags duplicate ids', () => {
    const dupStop = validate(fixtureWith((f) => editTable(f, 'stops.txt', (rows) => void rows.push({ ...rows[0]! }))));
    expect(dupStop.issues.find((i) => i.rule === 'stops.duplicate_id')).toMatchObject({ severity: 'error', samples: [readTable(fixtureFiles(), 'stops.txt')[0]!.stop_id] });
    const dupTrip = validate(fixtureWith((f) => editTable(f, 'trips.txt', (rows) => void rows.push({ ...rows[0]! }))));
    expect(rules(dupTrip, 'error')).toContain('trips.duplicate_id');
    const dupRoute = validate(fixtureWith((f) => editTable(f, 'routes.txt', (rows) => void rows.push({ ...rows[0]! }))));
    expect(rules(dupRoute, 'error')).toContain('routes.duplicate_id');
  });
});

describe('validateGtfs: referential integrity', () => {
  it('rejects a feed whose trips point at unknown routes', () => {
    const r = validate(fixtureWith((f) => editTable(f, 'trips.txt', (rows) => rows.forEach((t) => (t.route_id = 'ghost')))));
    expect(r.acceptable).toBe(false);
    expect(rules(r, 'error')).toEqual(expect.arrayContaining(['trips.fk_route', 'rows.drop_threshold_exceeded']));
  });

  it('rejects trips with an unknown service_id', () => {
    const r = validate(fixtureWith((f) => editTable(f, 'trips.txt', (rows) => rows.forEach((t) => (t.service_id = 'NOPE')))));
    expect(rules(r, 'error')).toContain('trips.fk_service');
  });

  it('rejects stop_times for unknown trips and unknown stops', () => {
    const orphan = validate(fixtureWith((f) => editTable(f, 'stop_times.txt', (rows) => rows.slice(0, 200).forEach((s) => (s.trip_id = 'ghost')))));
    expect(rules(orphan, 'error')).toContain('stop_times.fk_trip');
    const badStop = validate(fixtureWith(breakTrips(10, (rows) => (rows[2]!.stop_id = 'ghost'))));
    expect(rules(badStop, 'error')).toContain('stop_times.fk_stop');
  });

  it('drops a single offending trip and its stop_times but stays acceptable', () => {
    const parsed = parseGtfsZip(fixtureWith((f) => editTable(f, 'trips.txt', (rows) => void (rows[0]!.route_id = 'ghost'))));
    const { report, feed } = prepareGtfs(parsed, opts);
    expect(report.acceptable).toBe(true);
    expect(report.issues.find((i) => i.rule === 'trips.fk_route')).toMatchObject({ severity: 'warning', count: 1, samples: [parsed.trips[0]!.trip_id] });
    expect(report.dropped.trips).toBe(1);
    expect(feed.trips).toHaveLength(55);
    expect(feed.stopTimes.some((s) => s.trip_id === parsed.trips[0]!.trip_id)).toBe(false);
    expect(report.counts.trips).toBe(55);
    // the threshold is configurable
    expect(validateGtfs(parsed, { ...opts, maxDropFraction: 0 }).acceptable).toBe(false);
  });

  it('clears a dangling shape_id with a warning', () => {
    const { report, feed } = prepareGtfs(parseGtfsZip(fixtureWith((f) => editTable(f, 'trips.txt', (rows) => void (rows[0]!.shape_id = 'NO_SHAPE')))), opts);
    expect(report.acceptable).toBe(true);
    expect(rules(report, 'warning')).toContain('trips.fk_shape');
    expect(feed.trips.find((t) => t.shape_id === 'NO_SHAPE')).toBeUndefined();
  });
});

describe('validateGtfs: coordinates', () => {
  it('rejects invalid latitude/longitude', () => {
    const r = validate(
      fixtureWith((f) =>
        editTable(f, 'stops.txt', (rows) => {
          rows.slice(0, 60).forEach((s, i) => ((s.stop_lat = i % 2 ? 'abc' : '123.4'), (s.stop_lon = '79.9')));
        }),
      ),
    );
    expect(r.acceptable).toBe(false);
    expect(rules(r, 'error')).toContain('stops.invalid_coordinates');
  });

  it('rejects stops outside Sri Lanka (including 0,0)', () => {
    const r = validate(
      fixtureWith((f) =>
        editTable(f, 'stops.txt', (rows) => {
          rows.slice(0, 20).forEach((s) => ((s.stop_lat = '0'), (s.stop_lon = '0')));
          rows.slice(20, 40).forEach((s) => ((s.stop_lat = '51.5'), (s.stop_lon = '-0.12')));
        }),
      ),
    );
    expect(r.issues.find((i) => i.rule === 'stops.outside_sri_lanka')).toMatchObject({ severity: 'error', count: 40 });
  });

  it('drops one bad stop and every trip that visits it, within the threshold', () => {
    const files = fixtureFiles();
    const used = new Set(readTable(files, 'stop_times.txt').map((s) => s.stop_id));
    const victim = readTable(files, 'stops.txt').find((s) => !used.has(s.stop_id))!.stop_id;
    const r = validate(fixtureWith((f) => editTable(f, 'stops.txt', (rows) => void (rows.find((s) => s.stop_id === victim)!.stop_lat = '99'))));
    expect(r.acceptable).toBe(true);
    expect(r.dropped).toMatchObject({ stops: 1, trips: 0 });
    expect(r.counts.stops).toBe(219);
  });
});

describe('validateGtfs: stop_times', () => {
  it('rejects non-increasing stop_sequence', () => {
    const r = validate(fixtureWith(breakTrips(20, (rows) => (rows[2]!.stop_sequence = rows[1]!.stop_sequence))));
    expect(r.acceptable).toBe(false);
    expect(r.issues.find((i) => i.rule === 'stop_times.sequence_not_increasing')).toMatchObject({ severity: 'error', count: 20 });
  });

  it('rejects out-of-order stop_sequence in file order', () => {
    const r = validate(fixtureWith(breakTrips(20, (rows) => ((rows[1]!.stop_sequence = '99'), (rows[2]!.stop_sequence = '3')))));
    expect(rules(r, 'error')).toContain('stop_times.sequence_not_increasing');
  });

  it('rejects times going backwards and arrival later than departure', () => {
    const back = validate(fixtureWith(breakTrips(20, (rows) => (rows[3]!.arrival_time = rows[3]!.departure_time = '01:00:00'))));
    expect(rules(back, 'error')).toContain('stop_times.time_decreasing');
    const swap = validate(fixtureWith(breakTrips(20, (rows) => ((rows[1]!.arrival_time = '23:00:00'), (rows[1]!.departure_time = '22:00:00')))));
    expect(rules(swap, 'error')).toContain('stop_times.arrival_after_departure');
  });

  it('rejects malformed times and missing terminal times', () => {
    const bad = validate(fixtureWith(breakTrips(20, (rows) => (rows[1]!.arrival_time = 'soon'))));
    expect(rules(bad, 'error')).toContain('stop_times.invalid_time');
    const term = validate(fixtureWith(breakTrips(20, (rows) => (rows[0]!.arrival_time = rows[0]!.departure_time = ''))));
    expect(rules(term, 'error')).toContain('stop_times.missing_terminal_time');
  });

  it('drops one broken trip and reports it as a warning', () => {
    const r = validate(fixtureWith(breakTrips(1, (rows) => (rows[2]!.stop_sequence = rows[1]!.stop_sequence))));
    expect(r.acceptable).toBe(true);
    expect(r.issues.find((i) => i.rule === 'stop_times.sequence_not_increasing')).toMatchObject({ severity: 'warning', count: 1 });
    expect(r.counts.trips).toBe(55);
  });

  it('fills blank intermediate times and copies the other of arrival/departure', () => {
    const { report, feed } = prepareGtfs(
      parseGtfsZip(
        fixtureWith(
          breakTrips(1, (rows) => {
            rows[1]!.arrival_time = rows[1]!.departure_time = '';
            rows[2]!.arrival_time = '';
          }),
        ),
      ),
      opts,
    );
    expect(report.acceptable).toBe(true);
    expect(report.filled_stop_times).toBe(2);
    const first = feed.stopTimes.filter((s) => s.trip_id === 'TRIP_CM01_D0_T1').slice(0, 4);
    expect(first.every((s) => s.arrival_sec !== null && s.departure_sec !== null)).toBe(true);
    expect(first[1]!.arrival_sec!).toBeGreaterThanOrEqual(first[0]!.departure_sec!);
    expect(first[1]!.arrival_sec!).toBeLessThanOrEqual(first[3]!.arrival_sec!);
  });
});

describe('validateGtfs: service calendar', () => {
  const expired = fixtureWith((f) => editTable(f, 'calendar.txt', (rows) => void (rows[0]!.end_date = '20261001')));

  it('rejects a feed with no service on or after today', () => {
    const r = validate(expired);
    expect(r.acceptable).toBe(false);
    expect(r.issues.find((i) => i.rule === 'calendar.no_future_service')).toMatchObject({ severity: 'error' });
  });

  it('accepts the same feed when the injected clock is earlier, and rejects the good feed when it is later', () => {
    expect(validate(expired, { today: '2026-09-30' }).acceptable).toBe(true);
    const late = validateGtfs(parseGtfsZip(fixtureBytes()), { clock: { now: () => Date.parse('2028-01-02T00:00:00Z') } });
    expect(rules(late, 'error')).toContain('calendar.no_future_service');
  });

  it('warns when service is about to run out', () => {
    const r = validate(expired, { today: '2026-09-25' });
    expect(r.acceptable).toBe(true);
    expect(rules(r, 'warning')).toContain('calendar.expiring_soon');
  });

  it('rejects a calendar row that ends before it starts', () => {
    const r = validate(fixtureWith((f) => editTable(f, 'calendar.txt', (rows) => void (rows[0]!.end_date = '20251231'))));
    expect(r.acceptable).toBe(false);
    expect(rules(r, 'error')).toEqual(expect.arrayContaining(['calendar.invalid_row', 'trips.fk_service']));
  });
});

describe('validateGtfs: count-change bands', () => {
  const parsed = parseGtfsZip(fixtureBytes());

  it('flags needs_review (still acceptable) beyond the default 50% band', () => {
    const r = validateGtfs(parsed, { ...opts, previousCounts: { routes: 7, stops: 100, trips: 56 } });
    expect(r.acceptable).toBe(true);
    expect(r.needs_review).toBe(true);
    expect(r.issues.find((i) => i.rule === 'counts.band_exceeded')).toMatchObject({ severity: 'warning', samples: ['stops: 100 -> 220 (120%)'] });
  });

  it('is quiet inside the band and honours a custom band', () => {
    expect(validateGtfs(parsed, { ...opts, previousCounts: { routes: 7, stops: 200, trips: 60 } }).needs_review).toBe(false);
    expect(validateGtfs(parsed, { ...opts, previousCounts: { routes: 7, stops: 200, trips: 60 }, countChangeBand: 0.05 }).needs_review).toBe(true);
    expect(validateGtfs(parsed, { ...opts, previousCounts: null }).needs_review).toBe(false);
  });
});

describe('validateGtfs: misc', () => {
  it('warns about a timezone mismatch', () => {
    const r = validate(fixtureBytes(), { ...opts, expectedTimezone: 'Asia/Kolkata' });
    expect(rules(r, 'warning')).toContain('agency.timezone_mismatch');
    expect(r.acceptable).toBe(true);
  });

  it('builds an unacceptable report for unreadable archives', () => {
    const r = reportForParseError(new GtfsParseError('zip_invalid', 'bad'), opts);
    expect(r).toMatchObject({ acceptable: false, errors: 1 });
    expect(r.issues[0]!.rule).toBe('zip.invalid');
  });

  it('never leaves the cleaned feed with dangling references', () => {
    const { feed } = prepareGtfs(
      parseGtfsZip(fixtureWith(breakTrips(1, (rows) => (rows[2]!.stop_id = 'ghost')), (f) => editTable(f, 'trips.txt', (rows) => void (rows[5]!.service_id = 'X')))),
      opts,
    );
    const trips = new Set(feed.trips.map((t) => t.trip_id));
    const stops = new Set(feed.stops.map((s) => s.stop_id));
    expect(feed.stopTimes.every((s) => trips.has(s.trip_id) && stops.has(s.stop_id))).toBe(true);
    expect(feed.trips).toHaveLength(54);
  });
});
