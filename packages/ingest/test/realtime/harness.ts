import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LMT, type Clock, type Db } from '@lkt/core';
import { createPgliteDb, migrate } from '@lkt/db';
import { encodeFeed } from '@lkt/gtfs';

const dir = fileURLToPath(new URL('../../../../fixtures/lmt/', import.meta.url));
export const fixture = {
  vehicles: (): Uint8Array => new Uint8Array(readFileSync(`${dir}vehicle-positions.pb`)),
  tripUpdates: (): Uint8Array => new Uint8Array(readFileSync(`${dir}trip-updates.pb`)),
  alerts: (): Uint8Array => new Uint8Array(readFileSync(`${dir}alerts.pb`)),
};

/** Header timestamps of the 2026-10-20 capture (seconds) and a "now" shortly after it. */
export const CAPTURE = { vehicles: 1792499730, tripUpdates: 1792499739, alerts: 1792499736 } as const;
export const T0 = 1792499745_000;

export const provider = LMT;

export interface FakeClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}
export function fakeClock(start = T0): FakeClock {
  let t = start;
  return { now: () => t, set: (ms) => (t = ms), advance: (ms) => (t += ms) };
}

/** routes.txt of fixtures/lmt/gtfs.zip. */
export const ROUTES: [id: string, shortName: string][] = [
  ['8bc594e3-8ad6-4a0d-9138-bf8b4247e2f5', 'CM01'],
  ['f3eaf277-a6fa-4f5b-8a61-3b1758d9a4b8', 'CM02'],
  ['c0030000-0000-4000-8000-000000000003', 'CM03'],
  ['c0050000-0000-4000-8000-000000000005', 'CM05'],
  ['c0060000-0000-4000-8000-000000000006', 'CM06'],
  ['c0080000-0000-4000-8000-000000000008', 'CM08'],
  ['c0040000-0000-4000-8000-000000000004', 'CM04'],
];
export const routeId = (shortName: string): string => ROUTES.find((r) => r[1] === shortName)![0];

export type TestDb = Db & { close(): Promise<void> };

/** PGlite startup costs ~2 s: create one per test file and call resetStatic() between tests. */
export async function createDb(): Promise<TestDb> {
  const db = await createPgliteDb();
  await migrate(db);
  await db.query(`INSERT INTO providers (id, name, timezone) VALUES ('lmt', 'Lanka Metro Transit', 'Asia/Colombo')`, []);
  return db;
}

/** Back to "no static feed activated yet". */
export async function resetStatic(db: Db): Promise<void> {
  await db.query(`UPDATE providers SET active_feed_version_id = NULL WHERE id = 'lmt'`, []);
  await db.query(`DELETE FROM trips`, []);
  await db.query(`DELETE FROM routes`, []);
  await db.query(`DELETE FROM feed_versions`, []);
}

/** Adds a feed version with the given routes/trips and makes it the active one. */
export async function activateFeed(
  db: Db,
  label: string,
  routes: [string, string][] = ROUTES,
  trips: { id: string; route: string; direction: number }[] = [],
): Promise<string> {
  const fv = await db.query<{ id: string | number | bigint }>(
    `INSERT INTO feed_versions (provider_id, status, checksum, label, source_key) VALUES ('lmt', 'active', $1, $2, 'lmt.gtfs') RETURNING id`,
    [`sum-${label}`, label],
  );
  const id = String(fv.rows[0]!.id);
  for (const [rid, short] of routes) {
    await db.query(`INSERT INTO routes (feed_version_id, route_id, agency_id, short_name, long_name, route_type) VALUES ($1, $2, 'LMT', $3, $4, 3)`, [id, rid, short, `${short} long`]);
  }
  for (const t of trips) {
    await db.query(`INSERT INTO trips (feed_version_id, trip_id, route_id, service_id, direction_id) VALUES ($1, $2, $3, 'daily', $4)`, [id, t.id, t.route, t.direction]);
  }
  await db.query(`UPDATE providers SET active_feed_version_id = $1 WHERE id = 'lmt'`, [id]);
  return id;
}

/** The 7 fixture routes plus two static trips (whose ids, as in the real feed, never match realtime ids). */
export async function seed(db: Db, label = '2026-10-20T03:00Z-ab12cd'): Promise<string> {
  return activateFeed(db, label, ROUTES, [
    { id: 'TRIP_CM01_D0_T1', route: routeId('CM01'), direction: 0 },
    { id: 'TRIP_CM01_D1_T1', route: routeId('CM01'), direction: 1 },
  ]);
}

// -- synthetic feeds ----------------------------------------------------------------------------------------------

export interface V {
  id: string;
  trip?: string;
  lat?: number;
  lon?: number;
  ts?: number;
  routeId?: string;
}

export function vehiclesFeed(headerTs: number, list: V[]): Uint8Array {
  return encodeFeed({
    header: { gtfsRealtimeVersion: '2.0', incrementality: 0, timestamp: headerTs },
    entity: list.map((v) => ({
      id: v.id,
      vehicle: {
        trip: v.trip ? { tripId: v.trip, ...(v.routeId ? { routeId: v.routeId } : {}) } : undefined,
        position: { latitude: v.lat ?? 6.9, longitude: v.lon ?? 79.9 },
        timestamp: v.ts ?? headerTs - 2,
        vehicle: { id: v.id },
      },
    })),
  });
}

export function tripUpdatesFeed(headerTs: number, list: { id: string; trip: string; route?: string; arrival?: number }[]): Uint8Array {
  return encodeFeed({
    header: { gtfsRealtimeVersion: '2.0', incrementality: 0, timestamp: headerTs },
    entity: list.map((t) => ({
      id: t.id,
      tripUpdate: {
        trip: { tripId: t.trip, ...(t.route ? { routeId: t.route } : {}) },
        timestamp: headerTs,
        stopTimeUpdate: [{ stopSequence: 1, stopId: '69', arrival: { time: t.arrival ?? headerTs + 60, delay: 5 } }],
      },
    })),
  });
}

export function alertsFeed(headerTs: number, list: { id: string; text?: string; route?: string }[]): Uint8Array {
  return encodeFeed({
    header: { gtfsRealtimeVersion: '2.0', incrementality: 0, timestamp: headerTs },
    entity: list.map((a) => ({
      id: a.id,
      alert: {
        informedEntity: [{ routeId: a.route ?? 'CM01' }],
        ...(a.text ? { headerText: { translation: [{ text: a.text, language: 'en' }] } } : {}),
      },
    })),
  });
}
