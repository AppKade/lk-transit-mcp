import { describe, expect, it } from 'vitest';
import type { transit_realtime } from 'gtfs-realtime-bindings';
import { decodeFeed, encodeFeed, normalizeAlerts, normalizeTripUpdates, normalizeVehicles, type DecodedFeed } from '../../src/index.js';

const NOW = 1792499745_000;
const HEADER_TS = 1792499730;

function feed(entity: transit_realtime.IFeedEntity[]): DecodedFeed {
  const r = decodeFeed(encodeFeed({ header: { gtfsRealtimeVersion: '2.0', timestamp: HEADER_TS }, entity }), { nowMs: NOW });
  if (!r.ok) throw new Error(r.error);
  return r;
}

const veh = (id: string, over: Partial<transit_realtime.IVehiclePosition> = {}, pos: Partial<transit_realtime.IPosition> = {}): transit_realtime.IFeedEntity => ({
  id,
  vehicle: {
    trip: { tripId: 'LMT_CM01_0_X' },
    position: { latitude: 6.9, longitude: 79.9, ...pos },
    timestamp: HEADER_TS - 5,
    ...over,
  },
});

describe('vehicle quarantine', () => {
  it('quarantines bad entities and keeps the rest', () => {
    const r = normalizeVehicles(
      feed([
        veh('ok'),
        veh('lat', {}, { latitude: 91 }),
        veh('lon', {}, { longitude: 200 }),
        veh('null-island', {}, { latitude: 0, longitude: 0 }),
        veh('india', {}, { latitude: 13.08, longitude: 80.27 }),
        veh('future', { timestamp: NOW / 1000 + 600 }),
        veh('ancient', { timestamp: NOW / 1000 - 90_000 }),
        veh('dup'),
        veh('dup'),
        { id: 'no-vehicle' },
        { id: 'deleted', isDeleted: true, vehicle: { position: { latitude: 6.9, longitude: 79.9 } } },
        { id: 'no-pos', vehicle: { trip: { tripId: 'LMT_CM01_0_X' } } },
      ]),
      { nowMs: NOW },
    );
    expect(r.items.map((v) => v.entity_id)).toEqual(['ok', 'dup']);
    expect(Object.fromEntries(r.quarantined.map((q) => [q.entity_id, q.reason]))).toEqual({
      lat: 'invalid_coordinates',
      lon: 'invalid_coordinates',
      'null-island': 'outside_sri_lanka',
      india: 'outside_sri_lanka',
      future: 'timestamp_in_future',
      ancient: 'timestamp_too_old',
      dup: 'duplicate_entity_id',
      'no-vehicle': 'missing_vehicle',
      'no-pos': 'missing_position',
    });
  });

  it('handles undefined optionals and falls back to the header timestamp', () => {
    const r = normalizeVehicles(feed([{ id: 'bare', vehicle: { position: { latitude: 6.9, longitude: 79.9 } } }]), { nowMs: NOW });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      vehicle_id: null,
      label: null,
      trip_id: null,
      route_id_raw: null,
      direction_id: null,
      bearing: null,
      speed_mps: null,
      current_stop_id: null,
      current_status: null,
      occupancy_status: null,
      occupancy_percentage: null,
      observed_at_ms: HEADER_TS * 1000,
    });
  });

  it('prefers an explicit route_id and direction, and maps EMPTY occupancy (enum value 0)', () => {
    const r = normalizeVehicles(
      feed([veh('a', { trip: { tripId: 'LMT_CM01_0_X', routeId: 'CM09', directionId: 1 }, occupancyStatus: 0, currentStatus: 1 })]),
      { nowMs: NOW },
    );
    expect(r.items[0]).toMatchObject({ route_id_raw: 'CM09', direction_id: 1, occupancy_status: 'EMPTY', current_status: 'STOPPED_AT' });
  });

  it('drops impossible bearing and speed instead of the vehicle', () => {
    const r = normalizeVehicles(feed([veh('a', {}, { bearing: 720, speed: -3 })]), { nowMs: NOW });
    expect(r.items[0]).toMatchObject({ bearing: null, speed_mps: null });
  });
});

const tu = (id: string, stus: transit_realtime.TripUpdate.IStopTimeUpdate[], over: Partial<transit_realtime.ITripUpdate> = {}): transit_realtime.IFeedEntity => ({
  id,
  tripUpdate: { trip: { tripId: 'LMT_CM01_0_X', routeId: 'CM01', directionId: 0 }, timestamp: HEADER_TS, stopTimeUpdate: stus, ...over },
});
const stu = (seq: number, arrivalSec: number): transit_realtime.TripUpdate.IStopTimeUpdate => ({
  stopSequence: seq,
  stopId: String(seq),
  arrival: { time: arrivalSec, delay: 0 },
});

describe('trip update quarantine', () => {
  it('quarantines ordering, past predictions, missing refs, duplicates, bad timestamps', () => {
    const r = normalizeTripUpdates(
      feed([
        tu('ok', [stu(1, HEADER_TS + 10), stu(2, HEADER_TS + 100)]),
        tu('recent-past', [stu(1, HEADER_TS - 6)]),
        tu('unordered', [stu(2, HEADER_TS + 10), stu(1, HEADER_TS + 20)]),
        tu('repeat-seq', [stu(2, HEADER_TS + 10), stu(2, HEADER_TS + 20)]),
        tu('past', [stu(1, HEADER_TS - 3600)]),
        tu('far', [stu(1, NOW / 1000 + 3 * 86400)]),
        tu('future-ts', [stu(1, HEADER_TS + 10)], { timestamp: NOW / 1000 + 900 }),
        tu('no-stop', [{ arrival: { time: HEADER_TS + 10 } }]),
        { id: 'no-ref', tripUpdate: { trip: {}, stopTimeUpdate: [] } },
        { id: 'not-a-tu' },
        tu('dup', []),
        tu('dup', []),
      ]),
      { nowMs: NOW },
    );
    expect(r.items.map((t) => t.entity_id)).toEqual(['ok', 'recent-past', 'dup']);
    expect(Object.fromEntries(r.quarantined.map((q) => [q.entity_id, q.reason]))).toEqual({
      unordered: 'stop_time_updates_out_of_order',
      'repeat-seq': 'stop_time_updates_out_of_order',
      past: 'prediction_before_observation',
      far: 'prediction_too_far_ahead',
      'future-ts': 'timestamp_in_future',
      'no-stop': 'stop_time_update_missing_stop',
      'no-ref': 'missing_trip_reference',
      'not-a-tu': 'missing_trip_update',
      dup: 'duplicate_entity_id',
    });
  });

  it('maps relationships and keeps skipped stops', () => {
    const r = normalizeTripUpdates(
      feed([
        tu('c', [], { trip: { tripId: 'T', scheduleRelationship: 3 } }),
        tu('s', [{ stopSequence: 1, stopId: '5', scheduleRelationship: 1 }]),
      ]),
      { nowMs: NOW },
    );
    expect(r.items[0]!.schedule_relationship).toBe('CANCELED');
    expect(r.items[1]!.stop_time_updates[0]).toMatchObject({ schedule_relationship: 'SKIPPED', arrival_time_ms: null, arrival_delay_s: null });
  });
});

describe('alert quarantine', () => {
  const text = (t: string, language = 'en') => ({ translation: [{ text: t, language }] });
  const alert = (id: string, a: Partial<transit_realtime.IAlert>): transit_realtime.IFeedEntity => ({
    id,
    alert: { informedEntity: [{ routeId: 'CM01' }], headerText: text('Delay'), ...a },
  });

  it('normalises good alerts and quarantines unusable ones', () => {
    const r = normalizeAlerts(
      feed([
        alert('ok', { cause: 6, effect: 3, descriptionText: text('Accident at Kadawatha'), activePeriod: [{ start: HEADER_TS - 60 }], url: text('https://x.example/a') }),
        alert('notext', { headerText: undefined }),
        alert('blank', { headerText: text('   ') }),
        alert('noentity', { informedEntity: [] }),
        alert('badperiod', { activePeriod: [{ start: HEADER_TS, end: HEADER_TS - 100 }] }),
        alert('multi', { headerText: { translation: [{ text: 'தாமதம்', language: 'ta' }, { text: 'Delay', language: 'en-LK' }] } }),
      ]),
      { nowMs: NOW },
    );
    expect(r.items.map((a) => a.entity_id)).toEqual(['ok', 'multi']);
    expect(r.items[0]).toMatchObject({
      cause: 'ACCIDENT',
      effect: 'SIGNIFICANT_DELAYS',
      header: 'Delay',
      description: 'Accident at Kadawatha',
      url: 'https://x.example/a',
      active_periods: [{ start_ms: (HEADER_TS - 60) * 1000, end_ms: null }],
      informed_entities: [{ agency_id: null, route_id: 'CM01', stop_id: null, trip_id: null }],
      observed_at_ms: HEADER_TS * 1000,
    });
    expect(r.items[1]!.header).toBe('Delay');
    expect(Object.fromEntries(r.quarantined.map((q) => [q.entity_id, q.reason]))).toEqual({
      notext: 'missing_text',
      blank: 'missing_text',
      noentity: 'no_informed_entity',
      badperiod: 'invalid_active_period',
    });
  });
});
