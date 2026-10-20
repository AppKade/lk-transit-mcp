import { describe, expect, it } from 'vitest';
import { GtfsParseError, parseGtfsZip } from '../../src/static/index.js';
import { editTable, fixtureBytes, fixtureFiles, fixtureWith, without, zip } from './helpers.js';

describe('parseGtfsZip: real LMT fixture', () => {
  const p = parseGtfsZip(fixtureBytes());

  it('parses every known table with the expected row counts', () => {
    expect(p.agencies).toHaveLength(1);
    expect(p.routes).toHaveLength(7);
    expect(p.stops).toHaveLength(220);
    expect(p.trips).toHaveLength(56);
    expect(p.stopTimes).toHaveLength(1092);
    expect(p.calendars).toHaveLength(1);
    expect(p.calendarDates).toHaveLength(0);
    expect(p.shapes).toHaveLength(12393);
    expect(p.rowCounts).toMatchObject({ 'routes.txt': 7, 'stops.txt': 220, 'trips.txt': 56, 'stop_times.txt': 1092 });
    expect(p.ignoredFiles).toEqual(['fare_attributes.txt', 'fare_rules.txt']);
  });

  it('converts values', () => {
    expect(p.stopTimes[0]).toMatchObject({ trip_id: 'TRIP_CM01_D0_T1', stop_id: '1', stop_sequence: 1, arrival_sec: 6 * 3600 + 30 * 60, time_invalid: false });
    const pettah = p.stops.find((s) => s.stop_id === '22')!;
    expect(pettah).toMatchObject({ stop_name: 'Pettah', lat: 6.93444, lon: 79.85492, code: 'MCC81', location_type: 0 });
    expect(p.routes[0]).toMatchObject({ short_name: 'CM01', route_type: 3, color: '1A5A96' });
    expect(p.calendars[0]).toMatchObject({ service_id: 'SERV_LMT_DAILY', monday: true, sunday: true, start_date: '2026-01-01', end_date: '2027-12-31', flags_valid: true });
    expect(p.feedInfo).toMatchObject({ version: '1.0.0', end_date: '2027-12-31' });
    expect(p.trips[0]!.shape_id).toBe('SHAPE_CM08_D0');
    expect(p.stopTimes[0]!.pickup_type).toBeNull();
  });
});

describe('parseGtfsZip: tolerance', () => {
  it('handles BOM, CRLF and trailing blank lines', () => {
    const base = parseGtfsZip(fixtureBytes());
    const files = fixtureFiles();
    for (const k of ['stops.txt', 'trips.txt', 'stop_times.txt']) files[k] = '﻿' + files[k]!.replace(/\n/g, '\r\n') + '\r\n\r\n';
    const p = parseGtfsZip(zip(files));
    expect(p.stops).toEqual(base.stops);
    expect(p.trips).toEqual(base.trips);
    expect(p.stopTimes).toEqual(base.stopTimes);
  });

  it('allows times beyond 24:00:00 and un-padded hours', () => {
    const p = parseGtfsZip(
      fixtureWith((f) =>
        editTable(f, 'stop_times.txt', (rows) => {
          rows[0]!.arrival_time = '25:10:00';
          rows[0]!.departure_time = '6:30:00';
        }),
      ),
    );
    expect(p.stopTimes[0]).toMatchObject({ arrival_sec: 25 * 3600 + 600, departure_sec: 6 * 3600 + 1800 });
  });

  it('marks malformed values instead of throwing', () => {
    const p = parseGtfsZip(
      fixtureWith(
        (f) => editTable(f, 'stop_times.txt', (rows) => void (rows[1]!.arrival_time = '99:99:xx')),
        (f) => editTable(f, 'stops.txt', (rows) => void (rows[0]!.stop_lat = 'north')),
      ),
    );
    expect(p.stopTimes[1]!.time_invalid).toBe(true);
    expect(p.stopTimes[1]!.arrival_sec).toBeNull();
    expect(p.stops[0]!.lat).toBeNull();
  });

  it('tolerates missing optional files and empty optional columns', () => {
    const p = parseGtfsZip(fixtureWith(without('feed_info.txt'), without('shapes.txt'), without('calendar_dates.txt')));
    expect(p.feedInfo).toBeNull();
    expect(p.shapes).toEqual([]);
    expect(p.files['shapes.txt']).toBeUndefined();
    expect(p.stops[0]!.parent_station).toBeNull();
  });

  it('reads files nested in a folder and ignores directory entries and junk', () => {
    const files = fixtureFiles();
    const nested = Object.fromEntries(Object.entries(files).map(([k, v]) => [`feed/${k}`, v]));
    nested['__MACOSX/._stops.txt'] = 'junk';
    const p = parseGtfsZip(zip(nested));
    expect(p.stops).toHaveLength(220);
  });
});

describe('parseGtfsZip: bad archives', () => {
  it('rejects garbage, empty and truncated input with a typed error', () => {
    const bytes = fixtureBytes();
    const garbage = new Uint8Array(2048).map((_, i) => (i * 31 + 7) & 0xff);
    for (const bad of [garbage, new Uint8Array(0), bytes.slice(0, Math.floor(bytes.length / 2)), bytes.slice(0, bytes.length - 40)]) {
      let err: unknown;
      try {
        parseGtfsZip(bad);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(GtfsParseError);
      expect((err as GtfsParseError).code).toBe('zip_invalid');
    }
  });

  it('guards against zip bombs', () => {
    expect(() => parseGtfsZip(fixtureBytes(), { maxUncompressedBytes: 100_000 })).toThrow(/inflates beyond/);
  });

  it('rejects an archive with no files', () => {
    expect(() => parseGtfsZip(zip({}))).toThrow(GtfsParseError);
  });
});
