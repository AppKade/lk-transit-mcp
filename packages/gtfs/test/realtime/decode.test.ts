import { describe, expect, it } from 'vitest';
import { decodeFeed, encodeFeed, normalizeAlerts, normalizeTripUpdates, normalizeVehicles, parseTripId } from '../../src/index.js';
import { alertsPb, CAPTURE, CAPTURE_NOW_MS, tripUpdatesPb, vehiclePositionsPb } from './fixtures.js';

function decodeOk(bytes: Uint8Array, nowMs = CAPTURE_NOW_MS) {
  const f = decodeFeed(bytes, { nowMs });
  if (!f.ok) throw new Error(f.error);
  return f;
}

describe('real LMT fixtures', () => {
  it('decodes headers to epoch ms', () => {
    expect(decodeOk(vehiclePositionsPb()).header.timestamp_ms).toBe(CAPTURE.vehicles * 1000);
    expect(decodeOk(tripUpdatesPb()).header.timestamp_ms).toBe(CAPTURE.tripUpdates * 1000);
    const alerts = decodeOk(alertsPb());
    expect(alerts.header.timestamp_ms).toBe(CAPTURE.alerts * 1000);
    expect(alerts.entities).toHaveLength(0);
    expect(alerts.header.incrementality).toBe('FULL_DATASET');
  });

  it('normalises all 68 vehicles with no quarantine', () => {
    const r = normalizeVehicles(decodeOk(vehiclePositionsPb()), { nowMs: CAPTURE_NOW_MS });
    expect(r.quarantined).toEqual([]);
    expect(r.items).toHaveLength(68);
    const first = r.items[0]!;
    expect(first).toMatchObject({
      entity_id: 'vehicle-position-LMT_CM01_0_WP-NE-5208-0',
      vehicle_id: 'WP-NE-5208',
      license_plate: 'WP-NE-5208',
      trip_id: 'LMT_CM01_0_WP-NE-5208',
      route_id_raw: 'CM01',
      direction_id: 0,
      bearing: 307,
      speed_mps: 0,
      observed_at_ms: 1792499726_000,
      occupancy_status: 'MANY_SEATS_AVAILABLE',
      occupancy_percentage: 29,
    });
    expect(first.latitude).toBeCloseTo(6.9031563, 5);
    expect(first.longitude).toBeCloseTo(79.9074631, 5);
    expect(first.resolution.method).toBe('unresolved');
    // the second vehicle reports 43.4: kept as given (m/s per spec), see report for the unit oddity
    expect(r.items[1]!.speed_mps).toBeCloseTo(43.4, 3);
    expect(new Set(r.items.map((v) => v.route_id_raw))).toEqual(new Set(['CM01', 'CM02', 'CM03', 'CM04', 'CM05', 'CM06', 'CM08']));
    expect(new Set(r.items.map((v) => v.direction_id))).toEqual(new Set([0, 1]));
    const occ = new Set(r.items.map((v) => v.occupancy_status));
    expect(occ.has('MANY_SEATS_AVAILABLE')).toBe(true);
    expect([...occ].every((o) => o !== null)).toBe(true);
    // entity timestamps lag the header by up to ~30 min in this capture
    expect(Math.min(...r.items.map((v) => v.observed_at_ms))).toBe(1792497946_000);
  });

  it('normalises all 68 trip updates', () => {
    const r = normalizeTripUpdates(decodeOk(tripUpdatesPb()), { nowMs: CAPTURE_NOW_MS });
    expect(r.quarantined).toEqual([]);
    expect(r.items).toHaveLength(68);
    const t = r.items[0]!;
    expect(t).toMatchObject({
      entity_id: 'trip-update-LMT_CM03_0_WP-NE-6542-0',
      trip_id: 'LMT_CM03_0_WP-NE-6542',
      route_id_raw: 'CM03',
      direction_id: 0,
      vehicle_id: 'WP-NE-6542',
      schedule_relationship: 'SCHEDULED',
      observed_at_ms: 1792499736_000,
    });
    expect(t.stop_time_updates).toHaveLength(15);
    expect(t.stop_time_updates[0]).toEqual({
      stop_sequence: 7,
      stop_id: '69',
      arrival_time_ms: 1792499750_000,
      arrival_delay_s: 24,
      departure_time_ms: 1792499765_000,
      departure_delay_s: 24,
      schedule_relationship: 'SCHEDULED',
    });
  });

  it('normalises the empty alerts feed', () => {
    const r = normalizeAlerts(decodeOk(alertsPb()), { nowMs: CAPTURE_NOW_MS });
    expect(r).toEqual({ items: [], quarantined: [] });
  });

  it('parses the realtime trip id pattern', () => {
    expect(parseTripId('LMT_CM01_0_WP-NE-5208')).toEqual({ agency: 'LMT', route: 'CM01', direction: 0, vehicle: 'WP-NE-5208' });
    expect(parseTripId('LMT_CM03_1_WP-NE-1')?.direction).toBe(1);
    expect(parseTripId('TRIP_CM01_D0_T1')).toBeNull();
    expect(parseTripId(null)).toBeNull();
  });
});

describe('decode failures never throw', () => {
  it.each([
    ['empty', new Uint8Array(0), 'empty_payload'],
    ['garbage', new TextEncoder().encode('<html><body>502 Bad Gateway</body></html>'), 'decode_error'],
    ['truncated', vehiclePositionsPb().slice(0, 300), 'decode_error'],
  ])('%s payload', (_n, bytes, reason) => {
    const r = decodeFeed(bytes, { nowMs: CAPTURE_NOW_MS });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });

  it('rejects a header without timestamp and a header from the future', () => {
    const noTs = decodeFeed(encodeFeed({ header: { gtfsRealtimeVersion: '2.0' }, entity: [] }), { nowMs: CAPTURE_NOW_MS });
    expect(noTs).toMatchObject({ ok: false, reason: 'header_timestamp_missing' });
    const future = decodeFeed(encodeFeed({ header: { gtfsRealtimeVersion: '2.0', timestamp: 1792499745 + 3600 }, entity: [] }), { nowMs: CAPTURE_NOW_MS });
    expect(future).toMatchObject({ ok: false, reason: 'header_timestamp_future' });
  });
});
