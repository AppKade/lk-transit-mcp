/** Sri Lanka has no DST; Asia/Colombo is a fixed UTC+05:30 offset. */
export const COLOMBO_OFFSET_MINUTES = 330;
export const COLOMBO_OFFSET_MS = COLOMBO_OFFSET_MINUTES * 60_000;

/** GTFS "HH:MM:SS" (hours may exceed 24) -> seconds since the start of the service day. null if malformed. */
export function parseGtfsTime(value: string): number | null {
  const m = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function formatGtfsTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** "YYYYMMDD" or "YYYY-MM-DD" -> "YYYY-MM-DD"; null if invalid. */
export function normalizeServiceDate(value: string): string | null {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** The Colombo calendar date ("YYYY-MM-DD") containing the instant `epochMs`. */
export function colomboDate(epochMs: number): string {
  return new Date(epochMs + COLOMBO_OFFSET_MS).toISOString().slice(0, 10);
}

/** Epoch milliseconds of 00:00:00 Colombo time on a "YYYY-MM-DD" service date. */
export function serviceDayStartMs(serviceDate: string): number {
  const [y, m, d] = serviceDate.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) - COLOMBO_OFFSET_MS;
}

/** Epoch ms for `secondsSinceServiceDayStart` on `serviceDate` (handles >24h GTFS times). */
export function serviceTimeToEpochMs(serviceDate: string, secondsSinceServiceDayStart: number): number {
  return serviceDayStartMs(serviceDate) + secondsSinceServiceDayStart * 1000;
}

/** Add `days` to a "YYYY-MM-DD" date. */
export function addDays(serviceDate: string, days: number): string {
  const [y, m, d] = serviceDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday for a "YYYY-MM-DD" date. */
export function weekday(serviceDate: string): number {
  const [y, m, d] = serviceDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** ISO string with the +05:30 offset, for human/LLM-readable timestamps. */
export function toColomboIso(epochMs: number): string {
  const local = new Date(epochMs + COLOMBO_OFFSET_MS).toISOString().slice(0, 19);
  return `${local}+05:30`;
}
