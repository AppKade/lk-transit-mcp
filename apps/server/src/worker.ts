/**
 * Cloudflare Workers entry: REST + MCP `fetch`, hourly static-ingest `scheduled`, and the `RealtimeHubDO` Durable
 * Object (one per provider) that polls the GTFS-RT feeds from alarms. Deploy config: apps/server/wrangler.toml.
 *
 * Untested in a real Workers runtime (no wrangler/network in the authoring sandbox). Cloudflare types are declared
 * minimally below so the repo does not depend on @cloudflare/workers-types.
 */
import { LMT, PROVIDERS, ToolError, emptySnapshot, systemClock, type Db, type RealtimeSnapshot, type RealtimeSource } from '@lkt/core';
import { createNeonDb } from '@lkt/db';
import { RealtimeHub, ensureProvider, runStaticIngest, type HubState } from '@lkt/ingest';
import { createTransitQueries } from '@lkt/query';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { scrubString } from './errors.js';
import { createJsonLogger } from './logger.js';
import { InMemoryTokenBucket } from './rate-limit.js';

// ---- minimal Cloudflare runtime types ----
interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTimeMs: number): Promise<void>;
}
interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}
interface DurableObjectStub {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}
interface R2Bucket {
  put(key: string, value: Uint8Array): Promise<unknown>;
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
interface ScheduledController {
  cron: string;
  scheduledTime: number;
}

export interface Env {
  /** Secret: Neon connection string (use the pooled `-pooler` host). */
  DATABASE_URL: string;
  /** Secret: `name=secret[@tier],...` */
  API_KEYS?: string;
  ALLOWED_ORIGINS?: string;
  ALLOW_ANONYMOUS?: string;
  RATE_LIMIT_ANON_PER_MIN?: string;
  RATE_LIMIT_KEY_PER_MIN?: string;
  REALTIME_HUB: DurableObjectNamespace;
  /** Optional R2 bucket for GTFS zips and sampled raw GTFS-RT payloads. */
  ARCHIVE?: R2Bucket;
}

const log = createJsonLogger();
/** Module scope = one limiter per isolate (best effort). Swap in a Durable Object / Rate Limiting binding for global limits. */
const limiter = new InMemoryTokenBucket();

/** Fresh Neon pool for every query: Durable Objects must not hold WebSocket pools across requests. */
function ephemeralNeonDb(url: string): Db {
  return {
    async query(sql, params) {
      const db = createNeonDb(url);
      try {
        return await db.query(sql, params);
      } finally {
        await db.close().catch(() => undefined);
      }
    },
    async transaction(fn) {
      const db = createNeonDb(url);
      try {
        return await db.transaction(fn);
      } finally {
        await db.close().catch(() => undefined);
      }
    },
  };
}

function hubSource(env: Env): RealtimeSource {
  return {
    async getSnapshot(provider): Promise<RealtimeSnapshot> {
      if (!(provider in PROVIDERS)) return emptySnapshot(provider);
      const stub = env.REALTIME_HUB.get(env.REALTIME_HUB.idFromName(provider));
      const res = await stub.fetch(`https://realtime-hub/snapshot?provider=${encodeURIComponent(provider)}`);
      if (!res.ok) throw new ToolError('provider_unavailable', 'Realtime data is temporarily unavailable');
      return (await res.json()) as RealtimeSnapshot;
    },
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const db = createNeonDb(env.DATABASE_URL);
    const queries = createTransitQueries({ db, realtime: hubSource(env), clock: systemClock, providers: PROVIDERS, defaultProvider: LMT.id });
    // Cloudflare always sets cf-connecting-ip and strips client-supplied copies, so it is safe to trust here.
    const config = { ...configFromEnv(env as unknown as Record<string, string | undefined>), trustProxyHeaders: true };
    const app = createApp({ queries, config, log, limiter });
    try {
      return await app.fetch(request, env, ctx as never);
    } finally {
      ctx.waitUntil(db.close().catch(() => undefined));
    }
  },

  /** Hourly cron: conditional static GTFS ingest (checksum-gated, atomic activation). */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const db = createNeonDb(env.DATABASE_URL);
    const archive = env.ARCHIVE ? { put: async (key: string, bytes: Uint8Array) => void (await env.ARCHIVE!.put(key, bytes)) } : undefined;
    ctx.waitUntil(
      (async () => {
        try {
          await ensureProvider(db, LMT);
          const r = await runStaticIngest({ db, provider: LMT, ...(archive ? { archive } : {}) }, {});
          log.log(r.status === 'failed' ? 'error' : 'info', 'static_ingest', {
            cron: controller.cron,
            status: r.status,
            label: 'label' in r ? r.label : undefined,
            stage: r.status === 'failed' ? r.stage : undefined,
            error: r.status === 'failed' ? scrubString(r.error).slice(0, 200) : undefined,
          });
        } catch (err) {
          log.log('error', 'static_ingest', { status: 'error', error_class: err instanceof Error ? err.name : 'unknown' });
        } finally {
          await db.close().catch(() => undefined);
        }
      })(),
    );
  },
};

const STATE_KEY = 'hub-state';
const LAST_QUERY_KEY = 'last-query-at';

/**
 * Hosts the RealtimeHub for one provider. `alarm()` polls and re-arms itself; `GET /snapshot` serves the latest state
 * (and polls inline if the data is older than 1.5 poll intervals, e.g. after an idle period or cold start).
 */
export class RealtimeHubDO {
  private readonly hub: RealtimeHub;
  private lastQueryAt: number | null = null;
  private lastPollAt = 0;
  private lastQueryPersistedAt = 0;

  constructor(
    private readonly state: DurableObjectState,
    env: Env,
  ) {
    const archive = env.ARCHIVE;
    this.hub = new RealtimeHub({
      provider: LMT,
      db: ephemeralNeonDb(env.DATABASE_URL),
      ...(archive ? { sampler: { put: async (key: string, bytes: Uint8Array) => void (await archive.put(key, bytes)), every: 240 } } : {}),
    });
    void state.blockConcurrencyWhile(async () => {
      const saved = await state.storage.get<HubState>(STATE_KEY);
      if (saved && this.hub.importState(saved)) this.lastPollAt = saved.saved_at_ms;
      this.lastQueryAt = (await state.storage.get<number>(LAST_QUERY_KEY)) ?? null;
    });
  }

  private idle(): boolean {
    return this.lastQueryAt === null || Date.now() - this.lastQueryAt > 10 * 60_000;
  }

  private async pollAndSchedule(): Promise<void> {
    const r = await this.hub.pollOnce({ idle: this.idle() });
    this.lastPollAt = Date.now();
    await this.state.storage.put(STATE_KEY, this.hub.exportState());
    await this.state.storage.setAlarm(Date.now() + Math.max(r.next_poll_in_ms, this.hub.recommendedIntervalMs(this.lastQueryAt)));
    log.log(r.ok ? 'info' : 'warn', 'realtime_poll', { provider: LMT.id, ok: r.ok, notes: r.notes });
  }

  async alarm(): Promise<void> {
    await this.pollAndSchedule();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/snapshot') {
      const now = Date.now();
      this.lastQueryAt = now;
      if (now - this.lastQueryPersistedAt > 60_000) {
        this.lastQueryPersistedAt = now;
        await this.state.storage.put(LAST_QUERY_KEY, now);
      }
      if (now - this.lastPollAt > LMT.pollIntervalSeconds * 1500) await this.pollAndSchedule();
      else if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(now + LMT.pollIntervalSeconds * 1000);
      return Response.json(await this.hub.getSnapshot(url.searchParams.get('provider') ?? LMT.id));
    }
    if (request.method === 'GET' && url.pathname === '/metrics') return Response.json(this.hub.getMetrics());
    return new Response('Not found', { status: 404 });
  }
}
