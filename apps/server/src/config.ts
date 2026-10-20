/** Runtime configuration shared by the Node and Workers entries. Pure data, no platform imports. */

export interface RateLimit {
  /** Bucket size = maximum burst. */
  capacity: number;
  refillPerSecond: number;
}

export interface ApiKeyEntry {
  /** Non-secret label used for rate-limit buckets and logs. */
  id: string;
  /** The secret. Only ever compared via SHA-256 digests in constant time, never logged. */
  key: string;
  /** Key into `rateLimits.tiers`. */
  tier: string;
}

export interface AppConfig {
  /** Serve requests that carry no API key (rate limited with the `anonymous` bucket). */
  allowAnonymous: boolean;
  apiKeys: ApiKeyEntry[];
  /**
   * Exact browser origins (e.g. `https://app.example`) allowed for CORS and for `/mcp`. Requests with no Origin header
   * (non-browser clients) are always accepted. `*` allows every origin and is not recommended.
   */
  allowedOrigins: string[];
  rateLimits: { anonymous: RateLimit; tiers: Record<string, RateLimit> };
  maxBodyBytes: number;
  requestTimeoutMs: number;
  /** Trust `x-forwarded-for` / `x-real-ip` for the anonymous client key (only behind a proxy you control). */
  trustProxyHeaders: boolean;
}

export const DEFAULT_CONFIG: AppConfig = {
  allowAnonymous: true,
  apiKeys: [],
  allowedOrigins: [],
  rateLimits: {
    anonymous: { capacity: 30, refillPerSecond: 0.5 },
    tiers: {
      standard: { capacity: 120, refillPerSecond: 2 },
      pro: { capacity: 600, refillPerSecond: 10 },
    },
  },
  maxBodyBytes: 64 * 1024,
  requestTimeoutMs: 10_000,
  trustProxyHeaders: false,
};

export function defineConfig(partial: Partial<AppConfig> = {}): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    rateLimits: {
      anonymous: partial.rateLimits?.anonymous ?? DEFAULT_CONFIG.rateLimits.anonymous,
      tiers: { ...DEFAULT_CONFIG.rateLimits.tiers, ...partial.rateLimits?.tiers },
    },
  };
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return !['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase());
}

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function posNumber(v: string | undefined): number | undefined {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * `API_KEYS` format: comma separated `name=secret[@tier]` (tier defaults to `standard`); a bare `secret` gets the
 * name `key<N>`. Example: `alice=s3cret@pro,bob=0ther`.
 */
export function parseApiKeys(raw: string | undefined): ApiKeyEntry[] {
  return list(raw).map((item, i) => {
    const eq = item.indexOf('=');
    const name = eq > 0 ? item.slice(0, eq) : `key${i + 1}`;
    const rest = eq > 0 ? item.slice(eq + 1) : item;
    const at = rest.lastIndexOf('@');
    const key = at > 0 ? rest.slice(0, at) : rest;
    const tier = at > 0 ? rest.slice(at + 1) : 'standard';
    return { id: name, key, tier };
  });
}

/** Builds the config from environment variables / Workers bindings. */
export function configFromEnv(env: Record<string, string | undefined>): AppConfig {
  const anon = posNumber(env.RATE_LIMIT_ANON_PER_MIN);
  const keyed = posNumber(env.RATE_LIMIT_KEY_PER_MIN);
  const base = defineConfig();
  return defineConfig({
    allowAnonymous: bool(env.ALLOW_ANONYMOUS, true),
    apiKeys: parseApiKeys(env.API_KEYS),
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    trustProxyHeaders: bool(env.TRUST_PROXY, false),
    rateLimits: {
      anonymous: anon ? { capacity: anon, refillPerSecond: anon / 60 } : base.rateLimits.anonymous,
      tiers: keyed ? { standard: { capacity: keyed, refillPerSecond: keyed / 60 } } : {},
    },
  });
}
