import { describe, expect, it } from 'vitest';
import {
  addDays, colomboDate, computeFreshness, haversineMeters, makeId, normalizeServiceDate, parseGtfsTime, parseId,
  serviceTimeToEpochMs, toColomboIso, weekday, planTripInput, findStopsNearbyInput,
} from '../src/index.js';

describe('ids', () => {
  it('round-trips and keeps colons in source id', () => {
    expect(parseId(makeId('lmt', 'stop', '22'))).toEqual({ provider: 'lmt', type: 'stop', id: '22' });
    expect(parseId('lmt:trip:a:b')?.id).toBe('a:b');
    expect(parseId('nonsense')).toBeNull();
    expect(parseId('lmt:planet:1')).toBeNull();
  });
});

describe('time', () => {
  it('parses GTFS times beyond 24h', () => {
    expect(parseGtfsTime('06:30:00')).toBe(23400);
    expect(parseGtfsTime('25:10:05')).toBe(90605);
    expect(parseGtfsTime('6:70:00')).toBeNull();
  });
  it('handles Colombo offset', () => {
    // 2026-10-20T20:00Z is 01:30 on the 21st in Colombo
    const ms = Date.UTC(2026, 9, 20, 20, 0, 0);
    expect(colomboDate(ms)).toBe('2026-10-21');
    expect(toColomboIso(ms)).toBe('2026-10-21T01:30:00+05:30');
    expect(serviceTimeToEpochMs('2026-10-21', 5400)).toBe(ms);
    expect(serviceTimeToEpochMs('2026-10-20', 25 * 3600 + 1800)).toBe(ms);
  });
  it('dates', () => {
    expect(normalizeServiceDate('20271231')).toBe('2027-12-31');
    expect(normalizeServiceDate('20270231')).toBeNull();
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(weekday('2026-10-20')).toBe(2);
  });
});

describe('freshness', () => {
  it('classifies by upstream observation time', () => {
    const now = 1_000_000;
    expect(computeFreshness(now - 10_000, now, 90)).toEqual({ status: 'fresh', age_seconds: 10, threshold_seconds: 90 });
    expect(computeFreshness(now - 91_000, now, 90).status).toBe('stale');
    expect(computeFreshness(null, now, 90)).toEqual({ status: 'unavailable', age_seconds: null, threshold_seconds: 90 });
  });
});

describe('geo + schemas', () => {
  it('haversine', () => {
    const d = haversineMeters(6.93444, 79.85492, 6.92942, 79.86464);
    expect(d).toBeGreaterThan(1000);
    expect(d).toBeLessThan(1300);
  });
  it('rejects unknown keys and out of range', () => {
    expect(findStopsNearbyInput.safeParse({ latitude: 7, longitude: 80, extra: 1 }).success).toBe(false);
    expect(findStopsNearbyInput.safeParse({ latitude: 7, longitude: 80, radius_m: 9000 }).success).toBe(false);
    expect(findStopsNearbyInput.parse({ latitude: 7, longitude: 80 }).radius_m).toBe(800);
    expect(planTripInput.safeParse({ origin: {}, destination: { stop_id: 'x' } }).success).toBe(false);
  });
});
