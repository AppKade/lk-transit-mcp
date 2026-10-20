import { THRESHOLDS, computeFreshness, serviceDayStartMs, toColomboIso } from '@lkt/core';
import type { Envelope, Freshness, GetFeedStatusInput, ProviderConfig, RealtimeFeedKey } from '@lkt/core';
import { envelopeOf, realtimeKey, staticKey } from './envelope.js';
import type { QueryEnv } from './env.js';
import { pickProvider } from './refs.js';
import type { FeedStatusOut, ProviderOut } from './types.js';

const FEED_KEYS: RealtimeFeedKey[] = ['vehicle_positions', 'trip_updates', 'alerts'];
const THRESHOLD_BY_FEED: Record<RealtimeFeedKey, number> = {
  vehicle_positions: THRESHOLDS.vehicleSeconds,
  trip_updates: THRESHOLDS.tripUpdateSeconds,
  alerts: THRESHOLDS.alertSeconds,
};
const CALENDAR_WARN_DAYS = 14;
const ORPHAN_WARN_RATIO = 0.005;

export function listProviders(env: QueryEnv): ProviderOut[] {
  return Object.values(env.ctx.providers).map((p) => ({ provider: p.id, name: p.name, timezone: p.timezone, license: p.license }));
}

const daysBetween = (from: string, to: string) => Math.round((serviceDayStartMs(to) - serviceDayStartMs(from)) / 86_400_000);
const pct = (r: number) => `${(r * 100).toFixed(1)}%`;

export async function getFeedStatus(env: QueryEnv, input: GetFeedStatusInput): Promise<Envelope<FeedStatusOut>> {
  const cfg = pickProvider(env.ctx, input.provider);
  const feed = await env.activeFeed(cfg);
  const now = env.now();
  const today = env.today();
  const snapshot = await env.snapshot(cfg);
  const notes: string[] = [];

  const calendarDays = feed?.calendarEnd ? Math.max(0, daysBetween(today, feed.calendarEnd)) : null;
  if (!feed) {
    notes.push('No active static feed: timetable queries are unavailable until a feed is ingested and activated.');
  } else {
    notes.push(`Static feed ${feed.label} is active.`);
    if (feed.calendarEnd !== null && feed.calendarEnd < today) {
      notes.push(`The timetable calendar ended on ${feed.calendarEnd}; no scheduled service is available.`);
    } else if (calendarDays !== null && calendarDays < CALENDAR_WARN_DAYS) {
      notes.push(`The timetable calendar ends on ${feed.calendarEnd} (${calendarDays} days left); a new static feed is needed soon.`);
    }
  }

  const freshness = {} as Record<RealtimeFeedKey, Freshness>;
  const realtime = {} as FeedStatusOut['realtime'];
  for (const key of FEED_KEYS) {
    const state = snapshot.feeds[key];
    const f = computeFreshness(state.header_timestamp_ms, now, THRESHOLD_BY_FEED[key]);
    freshness[key] = f;
    realtime[key] = {
      ok: state.ok,
      last_success: state.last_success_ms === null ? null : toColomboIso(state.last_success_ms),
      header_age_seconds: f.age_seconds,
      freshness: f.status,
      entity_count: state.entity_count,
      quarantined_count: state.quarantined_count,
      consecutive_failures: state.consecutive_failures,
    };
    const label = key.replace('_', ' ');
    if (f.status === 'unavailable') {
      notes.push(`The ${label} feed has no successful poll yet; ${realtimeNote(key)}`);
    } else if (f.status === 'stale') {
      notes.push(`The ${label} feed is stale (${f.age_seconds} s old, limit ${f.threshold_seconds} s); ${realtimeNote(key)}`);
    }
    if (state.consecutive_failures > 0) notes.push(`The ${label} feed has failed ${state.consecutive_failures} consecutive poll(s).`);
    if (state.quarantined_count > 0) notes.push(`${state.quarantined_count} ${label} entities were quarantined as invalid.`);
  }

  const quality = {
    vehicle_orphan_ratio: snapshot.quality.vehicle_orphan_ratio,
    trip_update_orphan_ratio: snapshot.quality.trip_update_orphan_ratio,
  };
  if (quality.vehicle_orphan_ratio > ORPHAN_WARN_RATIO) {
    notes.push(`${pct(quality.vehicle_orphan_ratio)} of vehicles could not be matched to a route (limit ${pct(ORPHAN_WARN_RATIO)}).`);
  }
  if (quality.trip_update_orphan_ratio > ORPHAN_WARN_RATIO) {
    notes.push(`${pct(quality.trip_update_orphan_ratio)} of trip updates could not be matched to a route (limit ${pct(ORPHAN_WARN_RATIO)}).`);
  }

  const allUnavailable = FEED_KEYS.every((k) => freshness[k].status === 'unavailable');
  const degraded =
    FEED_KEYS.some((k) => freshness[k].status !== 'fresh') ||
    (feed?.calendarEnd != null && (calendarDays ?? Infinity) < CALENDAR_WARN_DAYS) ||
    quality.vehicle_orphan_ratio > ORPHAN_WARN_RATIO ||
    quality.trip_update_orphan_ratio > ORPHAN_WARN_RATIO;
  const overall: FeedStatusOut['overall'] = !feed || allUnavailable ? 'down' : degraded ? 'degraded' : 'healthy';
  if (overall === 'healthy') notes.push('All feeds are fresh.');

  const data: FeedStatusOut = {
    provider: cfg.id,
    name: cfg.name,
    static: {
      active_feed_version: feed?.label ?? null,
      activated_at: feed?.activatedMs == null ? null : toColomboIso(feed.activatedMs),
      calendar_end: feed?.calendarEnd ?? null,
      calendar_days_remaining: calendarDays,
      counts: feed?.counts ?? {},
    },
    realtime,
    quality,
    overall,
    notes,
  };

  return envelopeOf(cfg, now, feed, 'mixed', sourceKeys(cfg), summaryFreshness(freshness), data);
}

function realtimeNote(key: RealtimeFeedKey): string {
  if (key === 'trip_updates') return 'arrivals fall back to the timetable.';
  if (key === 'vehicle_positions') return 'vehicle positions should not be trusted.';
  return 'service alerts may be out of date.';
}

const sourceKeys = (cfg: ProviderConfig): string[] => [staticKey(cfg), ...FEED_KEYS.map((k) => realtimeKey(cfg, k))];

/** Envelope freshness: the worse of the two 90 s feeds (alerts are slow-moving and reported per feed). */
function summaryFreshness(f: Record<RealtimeFeedKey, Freshness>): Freshness {
  const pair = [f.vehicle_positions, f.trip_updates];
  const known = pair.filter((x) => x.status !== 'unavailable');
  if (known.length === 0) return f.vehicle_positions;
  const worst = known.reduce((a, b) => ((b.age_seconds ?? 0) > (a.age_seconds ?? 0) ? b : a));
  return { ...worst, status: known.some((x) => x.status === 'stale') ? 'stale' : 'fresh' };
}
