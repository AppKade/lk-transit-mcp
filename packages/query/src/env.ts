import { ToolError, colomboDate, emptySnapshot } from '@lkt/core';
import type { ProviderConfig, RealtimeSnapshot } from '@lkt/core';
import { TtlCache } from './cache.js';
import { loadCatalog } from './catalog.js';
import type { Catalog } from './catalog.js';
import type { QueryContext } from './types.js';

const LOOKUP_TTL_MS = 5 * 60_000;

export interface ActiveFeed {
  id: number;
  label: string;
  activatedMs: number | null;
  fetchedMs: number;
  calendarStart: string | null;
  calendarEnd: string | null;
  counts: Record<string, number>;
}

export interface StopRow {
  stop_id: string;
  name: string;
  code: string | null;
  lat: number;
  lon: number;
}

/** Shared state for the query modules: the context plus feed-version keyed caches. */
export class QueryEnv {
  private readonly catalogs: TtlCache<Catalog>;
  private readonly stops: TtlCache<StopRow | null>;

  constructor(readonly ctx: QueryContext) {
    this.catalogs = new TtlCache(ctx.clock, LOOKUP_TTL_MS, 16);
    this.stops = new TtlCache(ctx.clock, LOOKUP_TTL_MS, 10_000);
  }

  now(): number {
    return this.ctx.clock.now();
  }

  today(): string {
    return colomboDate(this.now());
  }

  /** The provider's active feed version, or null when it has none. One indexed lookup per call, never cached. */
  async activeFeed(cfg: ProviderConfig): Promise<ActiveFeed | null> {
    const r = await this.ctx.db.query<{
      id: number | string;
      label: string;
      activated_ms: number | null;
      fetched_ms: number;
      calendar_start: string | null;
      calendar_end: string | null;
      counts: Record<string, number> | string | null;
    }>(
      `SELECT fv.id, fv.label,
              (extract(epoch FROM fv.activated_at) * 1000)::float8 AS activated_ms,
              (extract(epoch FROM fv.fetched_at) * 1000)::float8 AS fetched_ms,
              fv.calendar_start::text AS calendar_start, fv.calendar_end::text AS calendar_end, fv.counts
         FROM providers p JOIN feed_versions fv ON fv.id = p.active_feed_version_id
        WHERE p.id = $1 AND fv.status = 'active'`,
      [cfg.id],
    );
    const row = r.rows[0];
    if (!row) return null;
    const counts = typeof row.counts === 'string' ? (JSON.parse(row.counts) as Record<string, number>) : (row.counts ?? {});
    return {
      id: Number(row.id),
      label: row.label,
      activatedMs: row.activated_ms === null ? null : Number(row.activated_ms),
      fetchedMs: Number(row.fetched_ms),
      calendarStart: row.calendar_start,
      calendarEnd: row.calendar_end,
      counts,
    };
  }

  async requireFeed(cfg: ProviderConfig): Promise<ActiveFeed> {
    const feed = await this.activeFeed(cfg);
    if (!feed) {
      throw new ToolError('provider_unavailable', `Provider '${cfg.id}' has no active static feed yet.`, { provider: cfg.id });
    }
    return feed;
  }

  catalog(cfg: ProviderConfig, feed: ActiveFeed): Promise<Catalog> {
    return this.catalogs.getOrLoad(`${cfg.id}:${feed.id}`, () => loadCatalog(this.ctx.db, feed.id));
  }

  stop(cfg: ProviderConfig, feed: ActiveFeed, sourceStopId: string): Promise<StopRow | null> {
    return this.stops.getOrLoad(`${cfg.id}:${feed.id}:${sourceStopId}`, async () => {
      const r = await this.ctx.db.query<StopRow>(
        `SELECT stop_id, name, code, lat, lon FROM stops WHERE feed_version_id = $1 AND stop_id = $2`,
        [feed.id, sourceStopId],
      );
      return r.rows[0] ?? null;
    });
  }

  /** Realtime snapshot; an unreachable realtime source degrades to an empty one (feeds read as 'unavailable'). */
  async snapshot(cfg: ProviderConfig): Promise<RealtimeSnapshot> {
    try {
      return await this.ctx.realtime.getSnapshot(cfg.id);
    } catch {
      return emptySnapshot(cfg.id);
    }
  }
}
