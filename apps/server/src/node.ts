/**
 * Node entry point (local dev, containers):  npx tsx apps/server/src/node.ts
 *
 * Env: PORT (8787), HOST (127.0.0.1), DATABASE_URL (Neon; otherwise in-process PGlite at PGLITE_DIR, default
 * ./.data/pglite, or `memory`), SKIP_INGEST=1, ALLOW_ANONYMOUS, API_KEYS, ALLOWED_ORIGINS, TRUST_PROXY,
 * RATE_LIMIT_ANON_PER_MIN, RATE_LIMIT_KEY_PER_MIN. See docs/api.md.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import { LMT, PROVIDERS, systemClock, type Db, type RealtimeSource } from '@lkt/core';
import { createNeonDb, createPgliteDb, migrate } from '@lkt/db';
import { RealtimeHub, ensureProvider, runStaticIngest } from '@lkt/ingest';
import { createTransitQueries } from '@lkt/query';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { scrubString } from './errors.js';
import { createJsonLogger } from './logger.js';

const env = process.env;
const log = createJsonLogger();
const port = Number(env.PORT ?? 8787);
const host = env.HOST ?? '127.0.0.1';
const IDLE_AFTER_MS = 10 * 60_000;

async function openDb(): Promise<Db & { close(): Promise<void> }> {
  if (env.DATABASE_URL) return createNeonDb(env.DATABASE_URL);
  const dir = env.PGLITE_DIR ?? './.data/pglite';
  if (dir === 'memory') return createPgliteDb();
  mkdirSync(dirname(dir), { recursive: true });
  return createPgliteDb(dir);
}

const db = await openDb();
await migrate(db);
await ensureProvider(db, LMT);

const hub = new RealtimeHub({ provider: LMT, db });
let lastQueryAt: number | null = null;
const idle = () => lastQueryAt === null || Date.now() - lastQueryAt > IDLE_AFTER_MS;

/** Queries read the hub directly; the first query after an idle period triggers an immediate poll. */
const realtime: RealtimeSource = {
  async getSnapshot(provider) {
    if (idle()) await hub.pollOnce({ force: true });
    lastQueryAt = Date.now();
    return hub.getSnapshot(provider);
  },
};

const queries = createTransitQueries({ db, realtime, clock: systemClock, providers: PROVIDERS, defaultProvider: LMT.id });
const config = configFromEnv(env);
const app = createApp({
  queries,
  config,
  log,
  getClientIp: (c) => (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress,
});

const server = serve({ fetch: app.fetch, port, hostname: host }, (addr) => {
  log.log('info', 'server_started', {
    address: `${addr.address}:${addr.port}`,
    database: env.DATABASE_URL ? 'neon' : (env.PGLITE_DIR ?? './.data/pglite'),
    allow_anonymous: config.allowAnonymous,
    api_keys: config.apiKeys.length,
    allowed_origins: config.allowedOrigins.length,
  });
});

let stopped = false;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let ingestTimer: ReturnType<typeof setInterval> | undefined;

async function ingest(): Promise<void> {
  try {
    const r = await runStaticIngest({ db, provider: LMT }, {});
    log.log(r.status === 'failed' || r.status === 'rejected' ? 'warn' : 'info', 'static_ingest', {
      status: r.status,
      label: 'label' in r ? r.label : undefined,
      stage: r.status === 'failed' ? r.stage : undefined,
      error: r.status === 'failed' ? scrubString(r.error).slice(0, 200) : undefined,
    });
  } catch (err) {
    log.log('warn', 'static_ingest', { status: 'error', error_class: err instanceof Error ? err.name : 'unknown' });
  }
}

async function pollLoop(): Promise<void> {
  if (stopped) return;
  let delay = LMT.pollIntervalSeconds * 1000;
  try {
    const r = await hub.pollOnce({ idle: idle() });
    delay = Math.max(r.next_poll_in_ms, hub.recommendedIntervalMs(lastQueryAt));
    log.log(r.ok ? 'info' : 'warn', 'realtime_poll', { provider: LMT.id, ok: r.ok, next_in_ms: delay, notes: r.notes });
  } catch (err) {
    log.log('error', 'realtime_poll', { provider: LMT.id, error_class: err instanceof Error ? err.name : 'unknown' });
  }
  if (!stopped) pollTimer = setTimeout(() => void pollLoop(), delay);
}

if (env.SKIP_INGEST === '1') {
  log.log('info', 'static_ingest', { status: 'skipped' });
} else {
  // Background: the server is already listening; an offline start just logs and continues.
  void ingest().then(() => void pollLoop());
  ingestTimer = setInterval(() => void ingest(), LMT.staticCheckIntervalSeconds * 1000);
  ingestTimer.unref();
}
if (env.SKIP_INGEST === '1') void pollLoop();

async function shutdown(signal: string): Promise<void> {
  if (stopped) return;
  stopped = true;
  log.log('info', 'shutdown', { signal });
  clearTimeout(pollTimer);
  clearInterval(ingestTimer);
  server.close();
  await db.close().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
