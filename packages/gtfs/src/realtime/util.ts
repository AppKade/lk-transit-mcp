/** Presence check: protobufjs puts defaults on the prototype, so only own properties were on the wire. */
export function has(obj: object | null | undefined, key: string): boolean {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
}

/** uint64/int64 may arrive as a number (no `long` available, e.g. Workers) or a Long-like object. */
export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n) ? n : null;
  }
  if (v && typeof v === 'object') {
    const l = v as { low?: unknown; high?: unknown; unsigned?: unknown; toNumber?: unknown };
    if (typeof l.toNumber === 'function') {
      const n = (l.toNumber as () => number).call(v);
      return Number.isFinite(n) ? n : null;
    }
    if (typeof l.low === 'number' && typeof l.high === 'number') {
      const lo = l.low >>> 0;
      const hi = l.unsigned ? l.high >>> 0 : l.high;
      return hi * 4294967296 + lo;
    }
  }
  return null;
}

/** POSIX seconds -> epoch ms. Absent or 0 (protobuf "unset") gives null. */
export function secondsToMs(v: unknown): number | null {
  const n = toNumber(v);
  return n === null || n <= 0 ? null : n * 1000;
}

/** Non-empty trimmed string or null. */
export function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** Optional int field: null when not on the wire. */
export function optInt(obj: object | null | undefined, key: string): number | null {
  if (!has(obj, key)) return null;
  const n = toNumber((obj as Record<string, unknown>)[key]);
  return n === null ? null : Math.trunc(n);
}

export function optFloat(obj: object | null | undefined, key: string): number | null {
  if (!has(obj, key)) return null;
  return toNumber((obj as Record<string, unknown>)[key]);
}
