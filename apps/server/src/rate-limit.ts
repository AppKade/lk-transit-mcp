import type { RateLimit } from './config.js';

export interface RateLimitDecision {
  allowed: boolean;
  /** Bucket capacity (the configured burst). */
  limit: number;
  remaining: number;
  /** Seconds until the bucket is full again. */
  resetSeconds: number;
  /** Seconds until one more token is available; 0 when allowed. */
  retryAfterSeconds: number;
}

/**
 * Pluggable limiter. `key` is already an opaque identifier (hashed IP or API key id), never a raw address.
 * A Durable Object or Cloudflare Rate Limiting binding implements the same method.
 */
export interface RateLimiter {
  take(key: string, limit: RateLimit, nowMs: number, cost?: number): Promise<RateLimitDecision>;
}

interface Bucket {
  tokens: number;
  updatedMs: number;
}

/** In-memory token bucket: correct for a single Node process / single isolate; not shared across instances. */
export class InMemoryTokenBucket implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly maxKeys = 50_000) {}

  async take(key: string, limit: RateLimit, nowMs: number, cost = 1): Promise<RateLimitDecision> {
    const b = this.buckets.get(key) ?? { tokens: limit.capacity, updatedMs: nowMs };
    const elapsed = Math.max(0, nowMs - b.updatedMs) / 1000;
    b.tokens = Math.min(limit.capacity, b.tokens + elapsed * limit.refillPerSecond);
    b.updatedMs = nowMs;
    const allowed = b.tokens >= cost;
    if (allowed) b.tokens -= cost;
    // Re-insert so Map iteration order approximates least-recently-used.
    this.buckets.delete(key);
    this.buckets.set(key, b);
    if (this.buckets.size > this.maxKeys) this.evict(limit, nowMs);
    const missing = limit.capacity - b.tokens;
    return {
      allowed,
      limit: limit.capacity,
      remaining: Math.floor(b.tokens),
      resetSeconds: Math.ceil(missing / limit.refillPerSecond),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((cost - b.tokens) / limit.refillPerSecond)),
    };
  }

  private evict(limit: RateLimit, nowMs: number): void {
    // Drop oldest entries first; full buckets lose nothing by being forgotten.
    let excess = this.buckets.size - this.maxKeys;
    for (const [k, b] of this.buckets) {
      if (excess <= 0) break;
      const refilled = b.tokens + ((nowMs - b.updatedMs) / 1000) * limit.refillPerSecond;
      if (refilled >= limit.capacity || excess > 0) {
        this.buckets.delete(k);
        excess--;
      }
    }
  }
}
