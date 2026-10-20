import { systemClock, ToolError, TOOL_INPUTS, type Clock, type Envelope } from '@lkt/core';
import type { TransitQueries } from '@lkt/query';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { routePath } from 'hono/route';
import { ApiKeyStore, extractApiKey, sha256, toHex } from './auth.js';
import type { AppConfig } from './config.js';
import { HttpError, errorBody, invalidArgument, normalizeError, scrubString, type ZodLikeError } from './errors.js';
import { createJsonLogger, type Logger } from './logger.js';
import { handleMcpRequest, SERVER_NAME, SERVER_VERSION } from './mcp.js';
import { InMemoryTokenBucket, type RateLimiter } from './rate-limit.js';
import type { ToolCallInfo } from './tools.js';

export interface AppDeps {
  queries: TransitQueries;
  clock?: Clock;
  config: AppConfig;
  log?: Logger;
  /** Defaults to an in-memory token bucket (per process / isolate). Plug a Durable Object or binding here. */
  limiter?: RateLimiter;
  /** Platform-specific socket address, used for anonymous rate limiting when proxy headers are not trusted. */
  getClientIp?: (c: Context) => string | undefined;
}

interface Vars {
  traceId: string;
  info: ToolCallInfo & { tier?: string; client_id?: string };
}
type AppContext = Context<{ Variables: Vars }>;

const NUMBER = /^-?\d+(\.\d+)?$/;
const CORS_ALLOW_HEADERS = 'authorization, content-type, x-api-key, accept, x-request-id, mcp-protocol-version, mcp-session-id';
const CORS_EXPOSE_HEADERS = 'x-request-id, ratelimit-limit, ratelimit-remaining, ratelimit-reset, retry-after';

/** Query-string values are strings; convert the ones the shared zod schemas expect as numbers. */
function coerce(raw: Record<string, unknown>, numeric: string[], csvNumbers: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const k of numeric) {
    const v = out[k];
    if (typeof v === 'string' && NUMBER.test(v)) out[k] = Number(v);
  }
  for (const k of csvNumbers) {
    const v = out[k];
    if (typeof v === 'string') {
      const parts = v.split(',').map((s) => s.trim());
      out[k] = parts.every((p) => NUMBER.test(p)) ? parts.map(Number) : v;
    }
  }
  return out;
}

function queryObject(c: AppContext): Record<string, unknown> {
  const params = new URL(c.req.url).searchParams;
  const out: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: ZodLikeError } }, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw invalidArgument(r.error);
  return r.data;
}

export function createApp(deps: AppDeps): Hono<{ Variables: Vars }> {
  const { queries, config } = deps;
  const clock = deps.clock ?? systemClock;
  const log = deps.log ?? createJsonLogger();
  const limiter = deps.limiter ?? new InMemoryTokenBucket();
  const keys = new ApiKeyStore(config.apiKeys);
  const app = new Hono<{ Variables: Vars }>();

  const originAllowed = (origin: string) =>
    config.allowedOrigins.includes('*') || config.allowedOrigins.some((o) => o.toLowerCase() === origin.toLowerCase());

  // 1. trace id, security headers, access log (route template + operational fields only; never query string or body).
  app.use('*', async (c, next) => {
    const supplied = c.req.header('x-request-id');
    const traceId = supplied && /^[A-Za-z0-9._-]{8,64}$/.test(supplied) ? supplied : crypto.randomUUID();
    c.set('traceId', traceId);
    c.set('info', {});
    c.header('x-request-id', traceId);
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    c.header('cache-control', 'no-store');
    c.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    c.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    c.header('cross-origin-resource-policy', 'same-site');
    const started = performance.now();
    try {
      await next();
    } finally {
      const route = routePath(c, -1);
      const info = c.get('info');
      log.log(c.res.status >= 500 ? 'error' : 'info', 'http_request', {
        trace_id: traceId,
        method: c.req.method,
        route: route === '/*' || route === '*' || route.endsWith('/*') ? '(unmatched)' : route,
        status: c.res.status,
        latency_ms: Math.round((performance.now() - started) * 10) / 10,
        provider: info.provider,
        tool: info.tool,
        error_code: info.error_code,
        tier: info.tier,
        client_id: info.client_id,
      });
    }
  });

  // 2. MCP Origin validation (DNS-rebinding defence): no Origin header is fine, a mismatching one is rejected.
  app.use('/mcp', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && !originAllowed(origin)) throw new HttpError('forbidden', 'Origin not allowed');
    await next();
  });

  // 3. CORS: only allow-listed origins get headers; preflights are answered here.
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (config.allowedOrigins.length > 0) c.header('vary', 'Origin', { append: true });
    if (origin && originAllowed(origin)) {
      c.header('access-control-allow-origin', config.allowedOrigins.includes('*') ? '*' : origin);
      c.header('access-control-expose-headers', CORS_EXPOSE_HEADERS);
      if (c.req.method === 'OPTIONS') {
        c.header('access-control-allow-methods', 'GET, POST, OPTIONS');
        c.header('access-control-allow-headers', CORS_ALLOW_HEADERS);
        c.header('access-control-max-age', '600');
      }
    }
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    await next();
  });

  // 4. Auth, rate limiting, request timeout for everything except /healthz and the index.
  const guard = async (c: AppContext, next: () => Promise<void>) => {
    const presented = extractApiKey(c.req.raw.headers);
    const info = c.get('info');
    const now = clock.now();
    let bucketKey: string;
    let limit = config.rateLimits.anonymous;
    if (presented !== null) {
      const entry = await keys.lookup(presented);
      if (!entry) {
        // Failed attempts still burn the anonymous bucket so keys cannot be brute-forced for free.
        await limiter.take(await clientKey(c), config.rateLimits.anonymous, now);
        throw new HttpError('unauthorized', 'Invalid API key', undefined, { 'www-authenticate': 'Bearer realm="lk-transit"' });
      }
      bucketKey = `key:${entry.id}`;
      limit = config.rateLimits.tiers[entry.tier] ?? config.rateLimits.tiers.standard ?? limit;
      info.tier = entry.tier;
      info.client_id = entry.id;
    } else {
      if (!config.allowAnonymous) {
        throw new HttpError('unauthorized', 'An API key is required', undefined, { 'www-authenticate': 'Bearer realm="lk-transit"' });
      }
      bucketKey = await clientKey(c);
      info.tier = 'anonymous';
    }
    const d = await limiter.take(bucketKey, limit, now);
    c.header('ratelimit-limit', String(d.limit));
    c.header('ratelimit-remaining', String(d.remaining));
    c.header('ratelimit-reset', String(d.resetSeconds));
    if (!d.allowed) {
      throw new HttpError('rate_limited', 'Rate limit exceeded; retry later', { retry_after_seconds: d.retryAfterSeconds }, { 'retry-after': String(d.retryAfterSeconds) });
    }
    await next();
  };

  /** Opaque, non-reversible client bucket id: raw addresses never reach the limiter store or logs. */
  async function clientKey(c: AppContext): Promise<string> {
    let ip: string | undefined;
    if (config.trustProxyHeaders) {
      ip =
        c.req.header('cf-connecting-ip') ??
        c.req.header('x-real-ip') ??
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    }
    ip ??= deps.getClientIp?.(c);
    return `ip:${toHex(await sha256(ip ?? 'unknown')).slice(0, 24)}`;
  }

  const timeout = async (_c: AppContext, next: () => Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HttpError('timeout', 'Request timed out')), config.requestTimeoutMs);
    });
    const work = next();
    work.catch(() => undefined);
    try {
      await Promise.race([work, limit]);
    } finally {
      clearTimeout(timer);
    }
  };

  const tooLarge = (c: AppContext) => {
    c.get('info').error_code = 'payload_too_large';
    return c.json(errorBody({ code: 'payload_too_large', message: `Request body exceeds ${config.maxBodyBytes} bytes` }), 413);
  };
  const limitBody = bodyLimit({ maxSize: config.maxBodyBytes, onError: tooLarge as never });

  app.use('/v1/*', guard, timeout);
  app.use('/mcp', guard, timeout);
  app.use('/v1/journeys/*', limitBody);
  app.use('/mcp', limitBody);

  // ---- unauthenticated, dependency-free ----
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/', (c) =>
    c.json({ name: SERVER_NAME, version: SERVER_VERSION, mcp: '/mcp', rest: '/v1', health: '/healthz' }),
  );

  // ---- REST /v1 ----
  const reply = async <T>(c: AppContext, run: () => Promise<Envelope<T>>) => {
    const env = await run();
    c.get('info').provider = env.provider;
    return c.json(env);
  };

  app.get('/v1/providers', async (c) => c.json({ data: await queries.listProviders() }));

  app.get('/v1/stops/nearby', (c) =>
    reply(c, () =>
      queries.findStopsNearby(parse(TOOL_INPUTS.find_stops_nearby, coerce(queryObject(c), ['latitude', 'longitude', 'radius_m', 'limit']))),
    ),
  );

  app.get('/v1/stops/:stop_id/arrivals', (c) =>
    reply(c, () =>
      queries.getArrivals(
        parse(TOOL_INPUTS.get_arrivals, { ...coerce(queryObject(c), ['within_minutes', 'limit']), stop_id: c.req.param('stop_id') }),
      ),
    ),
  );

  app.get('/v1/routes', (c) => reply(c, () => queries.searchRoutes(parse(TOOL_INPUTS.search_routes, coerce(queryObject(c), ['limit'])))));

  app.get('/v1/routes/:route_id', (c) =>
    reply(c, () => queries.getRoute(parse(TOOL_INPUTS.get_route, { ...coerce(queryObject(c), ['direction_id']), route_id: c.req.param('route_id') }))),
  );

  app.get('/v1/vehicles', (c) =>
    reply(c, () =>
      queries.getVehiclePositions(parse(TOOL_INPUTS.get_vehicle_positions, coerce(queryObject(c), ['max_age_seconds'], ['bbox']))),
    ),
  );

  app.get('/v1/alerts', (c) => reply(c, () => queries.getServiceAlerts(parse(TOOL_INPUTS.get_service_alerts, queryObject(c)))));

  app.post('/v1/journeys/plan', async (c) => {
    if (!(c.req.header('content-type') ?? '').toLowerCase().includes('application/json')) {
      throw new HttpError('unsupported_media_type', 'Content-Type must be application/json');
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new HttpError('invalid_argument', 'Body must be valid JSON');
    }
    return reply(c, () => queries.planTrip(parse(TOOL_INPUTS.plan_trip, body)));
  });

  app.get('/v1/health/providers', async (c) => {
    const providers = await queries.listProviders();
    const results = await Promise.all(
      providers.map(async (p) => {
        try {
          return { provider: p.provider, status: await queries.getFeedStatus({ provider: p.provider }) };
        } catch (err) {
          const n = normalizeError(err);
          return { provider: p.provider, error: { code: n.code, message: n.message } };
        }
      }),
    );
    return c.json({ providers: results });
  });

  app.get('/v1/provenance/:provider', async (c) => {
    const id = c.req.param('provider');
    const p = (await queries.listProviders()).find((x) => x.provider === id);
    if (!p) throw new ToolError('unknown_provider', `Unknown provider "${id.slice(0, 32)}"`);
    const status = await queries.getFeedStatus({ provider: id });
    c.get('info').provider = id;
    return c.json({
      provider: p.provider,
      name: p.name,
      timezone: p.timezone,
      license: p.license,
      as_of: status.as_of,
      source: status.source,
      freshness: status.freshness,
    });
  });

  // ---- MCP (stateless Streamable HTTP, JSON responses) ----
  app.post('/mcp', async (c) => {
    const res = await handleMcpRequest(c.req.raw, {
      queries,
      maxBodyBytes: config.maxBodyBytes,
      info: c.get('info'),
      onProtocolError: (message) => log.log('warn', 'mcp_protocol_error', { trace_id: c.get('traceId'), message }),
    });
    // Re-wrap so the headers set by the middleware above (trace id, security, rate limit, CORS) are merged in.
    return c.newResponse(res.body, res.status as 200, Object.fromEntries(res.headers));
  });
  app.on(['GET', 'DELETE'], '/mcp', (c) =>
    c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless and only accepts POST' }, id: null }, 405, {
      allow: 'POST',
    }),
  );

  app.notFound((c) => c.json(errorBody({ code: 'not_found', message: 'Not found' }), 404));

  app.onError((err, c) => {
    const n = normalizeError(err);
    const info = c.get('info');
    if (info) info.error_code = n.code;
    if (n.status >= 500 && n.code === 'internal') {
      // Only the error class is logged: messages/stacks may contain SQL, upstream URLs or coordinates.
      log.log('error', 'unhandled_error', { trace_id: c.get('traceId'), error_class: err instanceof Error ? err.name : typeof err });
    }
    return c.json(errorBody({ ...n, message: scrubString(n.message) }), n.status as 400, n.headers);
  });

  return app;
}
