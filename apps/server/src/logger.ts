/**
 * Structured JSON logging with privacy by construction: callers pass an allow-list of operational fields and every
 * record additionally goes through `redact()` so a coordinate, query string, token or payload cannot leak even if a
 * future caller passes one by mistake (requirement: exact rider coordinates are never retained in application logs).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
}

/** Keys whose values are never logged. Compared lower-cased with `-`/`_` removed. */
const SENSITIVE_KEYS = new Set([
  'latitude', 'longitude', 'lat', 'lon', 'lng', 'long', 'coordinates', 'coords', 'bbox', 'location', 'origin',
  'destination', 'query', 'q', 'querystring', 'search', 'url', 'body', 'payload', 'args', 'arguments', 'input', 'params',
  'authorization', 'apikey', 'xapikey', 'token', 'secret', 'password', 'cookie', 'ip', 'clientip', 'xforwardedfor',
]);

const COORD_PAIR = /-?\d{1,3}\.\d{3,}\s*[,;/\s]\s*-?\d{1,3}\.\d{3,}/g;
const COORD_PARAM = /\b(latitude|longitude|lat|lon|lng|bbox|q|query|origin|destination)=[^&\s"]*/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const LONG_DECIMAL = /-?\d{1,3}\.\d{4,}/g;

export function redactString(s: string): string {
  return s
    .replace(COORD_PARAM, '$1=[redacted]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(COORD_PAIR, '[coords]')
    .replace(LONG_DECIMAL, '[number]');
}

/** Deep-copies `v`, dropping sensitive keys and scrubbing coordinate/token-looking strings. */
export function redact(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return redactString(v);
  if (typeof v === 'number') return /^-?\d{1,3}\.\d{4,}$/.test(String(v)) ? '[number]' : v;
  if (v === null || typeof v !== 'object') return v;
  if (depth > 5) return '[truncated]';
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase().replace(/[-_]/g, '')) ? '[redacted]' : redact(x, depth + 1);
  }
  return out;
}

/** JSON-lines logger. `write` defaults to console.log (stdout in Node, Workers Logs on Cloudflare). */
export function createJsonLogger(write: (line: string) => void = (l) => console.log(l), now: () => number = Date.now): Logger {
  return {
    log(level, event, fields = {}) {
      const rec = { ts: new Date(now()).toISOString(), level, event, ...(redact(fields) as Record<string, unknown>) };
      write(JSON.stringify(rec));
    },
  };
}

export const noopLogger: Logger = { log() {} };
