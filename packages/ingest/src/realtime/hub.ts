import {
  emptyFeedState,
  emptySnapshot,
  systemClock,
  type Clock,
  type Db,
  type FeedState,
  type ProviderConfig,
  type RealtimeFeedKey,
  type RealtimeQuality,
  type RealtimeSnapshot,
  type RealtimeSource,
  type RtAlert,
  type RtTripUpdate,
  type RtVehicle,
  type SourceConfig,
} from '@lkt/core';
import {
  decodeFeed,
  normalizeAlerts,
  normalizeTripUpdates,
  normalizeVehicles,
  unresolvedResolution,
  type DecodedFeed,
  type Quarantined,
} from '@lkt/gtfs';
import { loadActiveStaticFeed, StaticIndex } from './resolve.js';
import {
  emptyMetrics,
  FEED_KEYS,
  type FeedPollOutcome,
  type HubMetrics,
  type HubSampler,
  type HubState,
  type PollOptions,
  type PollResult,
  type QuarantinedEntity,
} from './types.js';

export interface RealtimeHubOptions {
  provider: ProviderConfig;
  db: Db;
  clock?: Clock;
  fetchImpl?: typeof fetch;
  /** Per-feed fetch timeout, covering headers and body. Default 8 s. */
  timeoutMs?: number;
  /** Ceiling for the per-feed exponential backoff. Default 5 min. */
  maxBackoffMs?: number;
  sampler?: HubSampler;
}

const IDLE_INTERVAL_MS = 60_000;
const IDLE_AFTER_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
const MAX_REPORTED_QUARANTINE = 50;

type Raw =
  | { ok: true; notModified: true }
  | { ok: true; notModified: false; bytes: Uint8Array; etag: string | null }
  | { ok: false; error: string };

interface ResolverContext {
  index: StaticIndex | null;
  note: string | null;
}

/**
 * Realtime state for ONE provider: polls the configured GTFS-RT sources, decodes, quarantines bad entities, resolves
 * references against the active static feed and serves snapshots. Runtime agnostic (no Node APIs), so it can live in a
 * Durable Object: call pollOnce from an alarm, persist exportState() after each poll, importState() on wake-up.
 */
export class RealtimeHub implements RealtimeSource {
  private readonly provider: ProviderConfig;
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBackoffMs: number;
  private readonly sampler: HubSampler | undefined;

  private vehicles: RtVehicle[] = [];
  private tripUpdates: RtTripUpdate[] = [];
  private alerts: RtAlert[] = [];
  private feeds: Record<RealtimeFeedKey, FeedState> = {
    vehicle_positions: emptyFeedState(),
    trip_updates: emptyFeedState(),
    alerts: emptyFeedState(),
  };
  private nextAttemptMs: Record<RealtimeFeedKey, number> = { vehicle_positions: 0, trip_updates: 0, alerts: 0 };
  private metrics: HubMetrics = emptyMetrics();
  private resolvedFeedVersionId: string | null = null;
  private resolvedLabel: string | null = null;

  private index: StaticIndex | null = null;
  private readonly etags: Partial<Record<RealtimeFeedKey, string>> = {};
  private readonly olderStreak: Record<RealtimeFeedKey, number> = { vehicle_positions: 0, trip_updates: 0, alerts: 0 };
  private readonly sampleCount: Record<RealtimeFeedKey, number> = { vehicle_positions: 0, trip_updates: 0, alerts: 0 };
  private inflight: Promise<PollResult> | null = null;

  constructor(opts: RealtimeHubOptions) {
    this.provider = opts.provider;
    this.db = opts.db;
    this.clock = opts.clock ?? systemClock;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.sampler = opts.sampler;
  }

  /** How long to wait between polls: the configured interval, relaxed to 60 s when nobody queried for 10 minutes. */
  recommendedIntervalMs(lastQueryAtMs: number | null | undefined): number {
    const base = this.provider.pollIntervalSeconds * 1000;
    const idle = lastQueryAtMs === null || lastQueryAtMs === undefined || this.clock.now() - lastQueryAtMs > IDLE_AFTER_MS;
    return idle ? Math.max(base, IDLE_INTERVAL_MS) : base;
  }

  /** Never throws. Concurrent calls share one in-flight poll. */
  pollOnce(opts: PollOptions = {}): Promise<PollResult> {
    if (this.inflight) return this.inflight;
    const p = this.poll(opts).finally(() => {
      this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  async getSnapshot(provider?: string): Promise<RealtimeSnapshot> {
    if (provider !== undefined && provider !== this.provider.id) return emptySnapshot(provider);
    return structuredClone({
      provider: this.provider.id,
      vehicles: this.vehicles,
      tripUpdates: this.tripUpdates,
      alerts: this.alerts,
      feeds: this.feeds,
      quality: this.quality(),
    });
  }

  getMetrics(): HubMetrics {
    return structuredClone(this.metrics);
  }

  exportState(): HubState {
    return structuredClone({
      version: 1 as const,
      provider: this.provider.id,
      saved_at_ms: this.clock.now(),
      vehicles: this.vehicles,
      tripUpdates: this.tripUpdates,
      alerts: this.alerts,
      feeds: this.feeds,
      quality: this.quality(),
      resolved_feed_version_id: this.resolvedFeedVersionId,
      next_attempt_ms: this.nextAttemptMs,
      metrics: this.metrics,
    });
  }

  /** Returns false (and changes nothing) if the state is not a compatible export of this provider's hub. */
  importState(state: HubState): boolean {
    const s = state as Partial<HubState> | null | undefined;
    if (!s || s.version !== 1 || s.provider !== this.provider.id) return false;
    if (!Array.isArray(s.vehicles) || !Array.isArray(s.tripUpdates) || !Array.isArray(s.alerts) || !s.feeds || !s.metrics) return false;
    if (!FEED_KEYS.every((k) => s.feeds && s.feeds[k])) return false;
    const c = structuredClone(s as HubState);
    this.vehicles = c.vehicles;
    this.tripUpdates = c.tripUpdates;
    this.alerts = c.alerts;
    this.feeds = c.feeds;
    this.metrics = { ...emptyMetrics(), ...c.metrics };
    this.resolvedFeedVersionId = c.resolved_feed_version_id ?? null;
    this.resolvedLabel = c.quality?.resolved_against_feed_version ?? null;
    this.nextAttemptMs = { ...c.next_attempt_ms };
    for (const k of FEED_KEYS) this.nextAttemptMs[k] ??= 0;
    this.index = null;
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------------

  private quality(): RealtimeQuality {
    const ratio = (xs: { resolution: { method: string } }[]) =>
      xs.length === 0 ? 0 : xs.filter((x) => x.resolution.method === 'unresolved').length / xs.length;
    return {
      vehicle_orphan_ratio: ratio(this.vehicles),
      trip_update_orphan_ratio: ratio(this.tripUpdates),
      resolved_against_feed_version: this.resolvedLabel,
    };
  }

  private source(key: RealtimeFeedKey): SourceConfig | undefined {
    return this.provider.sources.find((s) => s.kind === 'gtfs_realtime' && s.feed === key);
  }

  private backoffMs(failures: number): number {
    const base = this.provider.pollIntervalSeconds * 1000;
    return Math.min(this.maxBackoffMs, base * 2 ** Math.min(failures, 16));
  }

  private async poll(opts: PollOptions): Promise<PollResult> {
    const startedAt = this.clock.now();
    const notes: string[] = [];
    const quarantined: QuarantinedEntity[] = [];
    const outcomes = {} as Record<RealtimeFeedKey, FeedPollOutcome>;
    try {
      const baseMs = Math.max(this.provider.pollIntervalSeconds * 1000, opts.idle ? IDLE_INTERVAL_MS : 0);
      const due = FEED_KEYS.filter((k) => this.source(k) && (opts.force || startedAt >= this.nextAttemptMs[k]));

      const ctxPromise = this.resolverContext();
      const raws = await Promise.all(due.map((k) => this.fetchRaw(k)));
      const ctx = await ctxPromise;
      if (ctx.note) notes.push(ctx.note);

      for (const key of FEED_KEYS) {
        const i = due.indexOf(key);
        if (i < 0) {
          outcomes[key] = this.skipped(key, startedAt);
          continue;
        }
        const t0 = this.clock.now();
        const outcome = await this.apply(key, raws[i]!, ctx, startedAt, baseMs, quarantined);
        outcome.duration_ms = Math.max(0, this.clock.now() - t0);
        outcomes[key] = outcome;
      }

      await this.reconcileResolution(ctx, notes);
    } catch (e) {
      // apply() guards each feed; this is the last line of defence so pollOnce can never reject.
      notes.push(`poll_error: ${errorMessage(e)}`);
    }
    for (const key of FEED_KEYS) outcomes[key] ??= this.skipped(key, startedAt);

    const now = this.clock.now();
    const configured = FEED_KEYS.filter((k) => this.source(k));
    const nextIn = configured.length === 0 ? this.provider.pollIntervalSeconds * 1000 : Math.min(...configured.map((k) => this.nextAttemptMs[k] - now));
    for (const key of FEED_KEYS) outcomes[key].next_attempt_in_ms = Math.max(0, this.nextAttemptMs[key] - now);

    if (this.resolvedFeedVersionId === null && (this.vehicles.length > 0 || this.tripUpdates.length > 0)) notes.push('no_active_feed');
    return {
      provider: this.provider.id,
      started_at_ms: startedAt,
      ok: FEED_KEYS.every((k) => outcomes[k].status !== 'failed'),
      feeds: outcomes,
      next_poll_in_ms: Math.max(1000, nextIn),
      resolved_against_feed_version: this.resolvedLabel,
      notes: [...new Set(notes)],
      quarantined: quarantined.slice(0, MAX_REPORTED_QUARANTINE),
    };
  }

  private skipped(key: RealtimeFeedKey, now: number): FeedPollOutcome {
    return {
      status: 'skipped',
      entity_count: this.feeds[key].entity_count,
      quarantined_count: this.feeds[key].quarantined_count,
      error: this.source(key) ? this.feeds[key].last_error : 'not_configured',
      duration_ms: 0,
      next_attempt_in_ms: Math.max(0, this.nextAttemptMs[key] - now),
    };
  }

  // -- fetching ---------------------------------------------------------------------------------------------------

  private async fetchRaw(key: RealtimeFeedKey): Promise<Raw> {
    const src = this.source(key)!;
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new Error(`timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });
    const work = (async (): Promise<Raw> => {
      const headers: Record<string, string> = { accept: 'application/x-protobuf, application/octet-stream;q=0.9, */*;q=0.1' };
      const etag = this.etags[key];
      if (etag) headers['if-none-match'] = etag;
      const res = await this.fetchImpl(src.url, { headers, signal: ac.signal });
      if (res.status === 304) return { ok: true, notModified: true };
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined);
        throw new Error(`HTTP ${res.status}`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > MAX_PAYLOAD_BYTES) throw new Error(`payload too large (${bytes.byteLength} bytes)`);
      return { ok: true, notModified: false, bytes, etag: res.headers.get('etag') };
    })();
    work.catch(() => undefined); // the timeout may win the race; do not leave an unhandled rejection behind
    try {
      return await Promise.race([work, timeout]);
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async sample(key: RealtimeFeedKey, bytes: Uint8Array, now: number): Promise<void> {
    const s = this.sampler;
    if (!s || !(s.every >= 1)) return;
    const n = this.sampleCount[key]++;
    if (n % Math.floor(s.every) !== 0) return;
    try {
      await s.put(`${this.provider.id}/${key}/${now}.pb`, bytes);
    } catch {
      this.metrics.sampler_errors_total++;
    }
  }

  // -- applying a fetched payload ---------------------------------------------------------------------------------

  private fail(key: RealtimeFeedKey, error: string, now: number, startedAt: number, kind: 'fetch' | 'decode'): FeedPollOutcome {
    const f = this.feeds[key];
    f.ok = false;
    f.consecutive_failures++;
    f.last_error = error;
    this.metrics.polls_failed_total++;
    this.metrics.by_feed[key].failed++;
    if (kind === 'decode') this.metrics.decode_errors_total++;
    else this.metrics.fetch_errors_total++;
    const delay = this.backoffMs(f.consecutive_failures);
    this.nextAttemptMs[key] = Math.max(now, startedAt) + delay;
    // The previous entities stay: consumers see them age into 'stale' via header_timestamp_ms / observed_at_ms.
    return { status: 'failed', entity_count: f.entity_count, quarantined_count: f.quarantined_count, error, duration_ms: 0, next_attempt_in_ms: delay };
  }

  private async apply(
    key: RealtimeFeedKey,
    raw: Raw,
    ctx: ResolverContext,
    startedAt: number,
    baseMs: number,
    quarantinedOut: QuarantinedEntity[],
  ): Promise<FeedPollOutcome> {
    const f = this.feeds[key];
    const now = this.clock.now();
    f.last_attempt_ms = startedAt;
    this.metrics.polls_total++;
    this.metrics.by_feed[key].polls++;
    try {
      if (!raw.ok) return this.fail(key, raw.error, now, startedAt, 'fetch');

      const succeed = (status: FeedPollOutcome['status']): FeedPollOutcome => {
        f.ok = true;
        f.consecutive_failures = 0;
        f.last_error = null;
        f.last_success_ms = now;
        this.nextAttemptMs[key] = startedAt + baseMs;
        return { status, entity_count: f.entity_count, quarantined_count: f.quarantined_count, error: null, duration_ms: 0, next_attempt_in_ms: baseMs };
      };

      if (raw.notModified) {
        this.metrics.not_modified_total++;
        return succeed('not_modified');
      }

      await this.sample(key, raw.bytes, now);
      const decoded = decodeFeed(raw.bytes, { nowMs: now });
      if (!decoded.ok) return this.fail(key, decoded.error, now, startedAt, 'decode');

      // A replica lagging behind the one we last read: keep the newer data. Three in a row means upstream really
      // moved backwards (restart, clock reset), so follow it rather than freezing on old data.
      if (f.header_timestamp_ms !== null && decoded.header.timestamp_ms < f.header_timestamp_ms && this.olderStreak[key] < 2) {
        this.olderStreak[key]++;
        this.metrics.older_payload_total++;
        return succeed('older_payload');
      }
      this.olderStreak[key] = 0;

      const { count, quarantined } = await this.store(key, decoded, ctx, now);
      if (raw.etag) this.etags[key] = raw.etag;
      else delete this.etags[key];
      f.header_timestamp_ms = decoded.header.timestamp_ms;
      f.entity_count = count;
      f.quarantined_count = quarantined.length;
      this.metrics.quarantined_total += quarantined.length;
      for (const q of quarantined) {
        this.metrics.quarantine_by_reason[q.reason] = (this.metrics.quarantine_by_reason[q.reason] ?? 0) + 1;
        quarantinedOut.push({ feed: key, entity_id: q.entity_id, reason: q.reason });
      }
      return succeed('updated');
    } catch (e) {
      return this.fail(key, `unexpected: ${errorMessage(e)}`, now, startedAt, 'decode');
    }
  }

  private async store(key: RealtimeFeedKey, decoded: DecodedFeed, ctx: ResolverContext, now: number): Promise<{ count: number; quarantined: Quarantined[] }> {
    switch (key) {
      case 'vehicle_positions': {
        const r = normalizeVehicles(decoded, { nowMs: now });
        if (this.provider.speedUnit === 'kmh') {
          for (const v of r.items) if (v.speed_mps !== null) v.speed_mps = v.speed_mps / 3.6;
        }
        await this.resolveVehicles(r.items, ctx);
        this.vehicles = r.items;
        return { count: r.items.length, quarantined: r.quarantined };
      }
      case 'trip_updates': {
        const r = normalizeTripUpdates(decoded, { nowMs: now });
        await this.resolveTripUpdates(r.items, ctx);
        this.tripUpdates = r.items;
        return { count: r.items.length, quarantined: r.quarantined };
      }
      case 'alerts': {
        const r = normalizeAlerts(decoded, { nowMs: now });
        this.alerts = r.items;
        return { count: r.items.length, quarantined: r.quarantined };
      }
    }
  }

  // -- resolution -------------------------------------------------------------------------------------------------

  /** Active feed lookup. Never throws; on a database error keeps using the last good index. */
  private async resolverContext(): Promise<ResolverContext> {
    try {
      const active = await loadActiveStaticFeed(this.db, this.provider.id);
      if (!active) {
        this.index = null;
        return { index: null, note: 'no_active_feed' };
      }
      if (!this.index || this.index.feedVersionId !== active.id) this.index = await StaticIndex.load(this.db, active);
      return { index: this.index, note: null };
    } catch (e) {
      return { index: this.index, note: `static_lookup_failed: ${errorMessage(e)}` };
    }
  }

  private async prefetch(ctx: ResolverContext, tripIds: (string | null)[]): Promise<void> {
    if (!ctx.index) return;
    try {
      await ctx.index.prefetchTrips(tripIds.filter((t): t is string => t !== null));
    } catch {
      // Trip lookups are an optimisation over route-level resolution; carry on with what is cached.
    }
  }

  private async resolveVehicles(items: RtVehicle[], ctx: ResolverContext): Promise<void> {
    await this.prefetch(ctx, items.map((v) => v.trip_id));
    for (const v of items) {
      v.resolution = ctx.index
        ? ctx.index.resolve({ tripId: v.trip_id, routeRaw: v.route_id_raw, direction: v.direction_id })
        : { ...unresolvedResolution(), direction_id: v.direction_id };
    }
  }

  private async resolveTripUpdates(items: RtTripUpdate[], ctx: ResolverContext): Promise<void> {
    await this.prefetch(ctx, items.map((t) => t.trip_id));
    for (const t of items) {
      t.resolution = ctx.index
        ? ctx.index.resolve({ tripId: t.trip_id, routeRaw: t.route_id_raw, direction: t.direction_id })
        : { ...unresolvedResolution(), direction_id: t.direction_id };
    }
  }

  /** If the active static feed changed since the held entities were resolved, resolve them again. */
  private async reconcileResolution(ctx: ResolverContext, notes: string[]): Promise<void> {
    const id = ctx.index?.feedVersionId ?? null;
    // A transient database failure keeps the previous index, so a null id here means "really no active feed".
    if (id !== this.resolvedFeedVersionId) {
      if (this.resolvedFeedVersionId !== null) notes.push(`feed_version_changed: ${this.resolvedFeedVersionId} -> ${id ?? 'none'}`);
      await this.resolveVehicles(this.vehicles, ctx);
      await this.resolveTripUpdates(this.tripUpdates, ctx);
      this.resolvedFeedVersionId = id;
    }
    this.resolvedLabel = ctx.index?.label ?? null;
  }
}

function errorMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 300 ? `${m.slice(0, 300)}...` : m;
}
