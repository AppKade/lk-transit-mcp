import { computeFreshness, makeEnvelope, makeSource } from '@lkt/core';
import type { Envelope, EnvelopeSource, Freshness, ProviderConfig, RealtimeFeedKey } from '@lkt/core';
import type { ActiveFeed } from './env.js';

/** Static timetables change rarely; a feed older than this is called stale (also stale once its calendar has ended). */
export const STATIC_STALE_SECONDS = 30 * 86_400;

export function staticKey(cfg: ProviderConfig): string {
  return cfg.sources.find((s) => s.kind === 'gtfs_static')?.key ?? `${cfg.id}.gtfs`;
}

export function realtimeKey(cfg: ProviderConfig, feed: RealtimeFeedKey): string {
  return cfg.sources.find((s) => s.feed === feed)?.key ?? `${cfg.id}.${feed}`;
}

/** Freshness note for answers that come from the static feed alone. */
export function staticFreshness(feed: ActiveFeed | null, nowMs: number, today: string): Freshness {
  if (!feed) return { status: 'unavailable', age_seconds: null, threshold_seconds: STATIC_STALE_SECONDS };
  const f = computeFreshness(feed.activatedMs ?? feed.fetchedMs, nowMs, STATIC_STALE_SECONDS);
  if (feed.calendarEnd !== null && feed.calendarEnd < today) f.status = 'stale';
  return f;
}

export function envelopeOf<T>(
  cfg: ProviderConfig,
  nowMs: number,
  feed: ActiveFeed | null,
  type: EnvelopeSource['type'],
  urlRef: string[],
  freshness: Freshness,
  data: T,
): Envelope<T> {
  return makeEnvelope(cfg.id, nowMs, freshness, makeSource(type, urlRef, feed?.label ?? null, cfg.license), data);
}
