import type { Clock } from '@lkt/core';

/** Small TTL cache driven by the injected clock. Concurrent loads of one key share a single promise. */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: Promise<V>; expiresAt: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly ttlMs: number,
    private readonly maxEntries = 1000,
  ) {}

  getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const now = this.clock.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.value;
    const value = load();
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
