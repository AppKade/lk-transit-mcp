export type FreshnessStatus = 'fresh' | 'stale' | 'unavailable';

export interface Freshness {
  status: FreshnessStatus;
  /** null when status is 'unavailable' (no observation at all). */
  age_seconds: number | null;
  threshold_seconds: number;
}

/** Thresholds from the requirement (GTFS-RT best practice). */
export const THRESHOLDS = {
  vehicleSeconds: 90,
  tripUpdateSeconds: 90,
  alertSeconds: 600,
} as const;

/**
 * `observedAtMs` is the upstream timestamp of the data (feed header or entity timestamp), NOT our fetch time:
 * a feed we fetched a second ago that was last updated 20 minutes ago is stale.
 */
export function computeFreshness(observedAtMs: number | null, nowMs: number, thresholdSeconds: number): Freshness {
  if (observedAtMs === null || !Number.isFinite(observedAtMs)) {
    return { status: 'unavailable', age_seconds: null, threshold_seconds: thresholdSeconds };
  }
  const age = Math.max(0, Math.round((nowMs - observedAtMs) / 1000));
  return { status: age <= thresholdSeconds ? 'fresh' : 'stale', age_seconds: age, threshold_seconds: thresholdSeconds };
}
