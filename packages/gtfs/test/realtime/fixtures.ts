import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../../../../fixtures/lmt/', import.meta.url));

export const vehiclePositionsPb = (): Uint8Array => new Uint8Array(readFileSync(`${dir}vehicle-positions.pb`));
export const tripUpdatesPb = (): Uint8Array => new Uint8Array(readFileSync(`${dir}trip-updates.pb`));
export const alertsPb = (): Uint8Array => new Uint8Array(readFileSync(`${dir}alerts.pb`));

/** Header timestamps of the 2026-10-20 capture (seconds). */
export const CAPTURE = { vehicles: 1792499730, tripUpdates: 1792499739, alerts: 1792499736 } as const;
/** A moment a few seconds after the capture. */
export const CAPTURE_NOW_MS = 1792499745_000;
