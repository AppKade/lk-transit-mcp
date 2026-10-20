import type { FeedState, RealtimeFeedKey, RealtimeQuality, RtAlert, RtTripUpdate, RtVehicle } from '@lkt/core';

export const FEED_KEYS: readonly RealtimeFeedKey[] = ['vehicle_positions', 'trip_updates', 'alerts'];

export type FeedPollStatus =
  /** New payload decoded and applied. */
  | 'updated'
  /** HTTP 304 (ETag matched). Data kept; freshness keeps ageing from the header timestamp. */
  | 'not_modified'
  /** Valid payload whose header is older than what we hold (a lagging upstream replica); ignored. */
  | 'older_payload'
  | 'failed'
  /** Not attempted: still inside its backoff window, or not configured for this provider. */
  | 'skipped';

export interface FeedPollOutcome {
  status: FeedPollStatus;
  entity_count: number;
  quarantined_count: number;
  error: string | null;
  duration_ms: number;
  /** When this feed is next due (relative to the end of the poll). */
  next_attempt_in_ms: number;
}

export interface QuarantinedEntity {
  feed: RealtimeFeedKey;
  entity_id: string;
  reason: string;
}

export interface PollResult {
  provider: string;
  started_at_ms: number;
  /** True when every attempted feed succeeded (also true when nothing was due). */
  ok: boolean;
  feeds: Record<RealtimeFeedKey, FeedPollOutcome>;
  /** Delay the caller should wait before the next pollOnce (exponential backoff when feeds are failing). */
  next_poll_in_ms: number;
  resolved_against_feed_version: string | null;
  /** Human-readable data-quality remarks, e.g. `no_active_feed`. */
  notes: string[];
  /** First few quarantined entities of this poll (full count is in `feeds[*].quarantined_count`). */
  quarantined: QuarantinedEntity[];
}

export interface PollOptions {
  /** Nobody has queried recently: schedule the next poll at the relaxed interval. Nothing is skipped. */
  idle?: boolean;
  /** Ignore per-feed backoff windows and fetch all feeds now. */
  force?: boolean;
}

export interface HubMetrics {
  /** Feed fetch attempts (three per full poll). */
  polls_total: number;
  polls_failed_total: number;
  quarantined_total: number;
  decode_errors_total: number;
  fetch_errors_total: number;
  not_modified_total: number;
  older_payload_total: number;
  sampler_errors_total: number;
  by_feed: Record<RealtimeFeedKey, { polls: number; failed: number }>;
  quarantine_by_reason: Record<string, number>;
}

export interface HubSampler {
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Store 1 in `every` raw payloads per feed (the first one, then every N-th). Undecodable payloads are sampled too. */
  every: number;
}

/** JSON-serialisable hub state, for Durable Object storage. */
export interface HubState {
  version: 1;
  provider: string;
  saved_at_ms: number;
  vehicles: RtVehicle[];
  tripUpdates: RtTripUpdate[];
  alerts: RtAlert[];
  feeds: Record<RealtimeFeedKey, FeedState>;
  quality: RealtimeQuality;
  resolved_feed_version_id: string | null;
  next_attempt_ms: Record<RealtimeFeedKey, number>;
  metrics: HubMetrics;
}

export function emptyMetrics(): HubMetrics {
  return {
    polls_total: 0,
    polls_failed_total: 0,
    quarantined_total: 0,
    decode_errors_total: 0,
    fetch_errors_total: 0,
    not_modified_total: 0,
    older_payload_total: 0,
    sampler_errors_total: 0,
    by_feed: {
      vehicle_positions: { polls: 0, failed: 0 },
      trip_updates: { polls: 0, failed: 0 },
      alerts: { polls: 0, failed: 0 },
    },
    quarantine_by_reason: {},
  };
}
