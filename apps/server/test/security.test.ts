import { describe, expect, it } from 'vitest';
import { InMemoryTokenBucket } from '../src/rate-limit.js';
import { ApiKeyStore, timingSafeEqual } from '../src/auth.js';
import { configFromEnv, parseApiKeys } from '../src/config.js';
import { fakeQueries, harness } from './helpers.js';

const MCP = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
const err = async (r: Response) => ((await r.json()) as any).error;

describe('Origin validation and CORS', () => {
  it('/mcp: no Origin is accepted, allow-listed Origin is accepted, any other Origin is 403', async () => {
    const h = harness({ allowedOrigins: ['https://app.example'] });
    const post = (origin?: string) => h.req('/mcp', { method: 'POST', headers: { ...MCP, ...(origin ? { origin } : {}) }, body: INIT });
    expect((await post()).status).toBe(200);
    expect((await post('https://app.example')).status).toBe(200);
    const bad = await post('https://evil.example');
    expect(bad.status).toBe(403);
    expect((await err(bad)).code).toBe('forbidden');
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    expect((await h.req('/mcp', { method: 'GET', headers: { origin: 'http://localhost:9999' } })).status).toBe(403);
  });

  it('with an empty allow-list every browser Origin is refused on /mcp', async () => {
    const h = harness();
    expect((await h.req('/mcp', { method: 'POST', headers: { ...MCP, origin: 'https://anything.example' }, body: INIT })).status).toBe(403);
  });

  it('REST CORS headers only for allow-listed origins; preflight answered with 204', async () => {
    const h = harness({ allowedOrigins: ['https://app.example'] });
    const ok = await h.req('/v1/providers', { headers: { origin: 'https://app.example' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(ok.headers.get('vary')).toContain('Origin');
    const other = await h.req('/v1/providers', { headers: { origin: 'https://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await h.req('/v1/providers', { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'GET' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/authorization/);
    const preBad = await h.req('/v1/providers', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(preBad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('sets security headers and a request id on every response, echoing a sane client id', async () => {
    const h = harness();
    const r = await h.req('/v1/providers', { headers: { 'x-request-id': 'client-req-12345' } });
    expect(r.headers.get('x-request-id')).toBe('client-req-12345');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    const r2 = await h.req('/v1/providers', { headers: { 'x-request-id': 'bad id\twith spaces' } });
    expect(r2.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const mcp = await h.req('/mcp', { method: 'POST', headers: MCP, body: INIT });
    expect(mcp.headers.get('x-request-id')).toBeTruthy();
    expect(mcp.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('rate limiting', () => {
  it('anonymous clients are limited per bucket and get 429 with ToolError shape and headers', async () => {
    const h = harness({ rateLimits: { anonymous: { capacity: 3, refillPerSecond: 0.1 }, tiers: {} } });
    const rs = [];
    for (let i = 0; i < 5; i++) rs.push(await h.req('/v1/providers'));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 429, 429]);
    expect(rs[0]!.headers.get('ratelimit-limit')).toBe('3');
    expect(rs[0]!.headers.get('ratelimit-remaining')).toBe('2');
    const limited = rs[3]!;
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await err(limited)).toMatchObject({ code: 'rate_limited', details: { retry_after_seconds: expect.any(Number) } });
    // /healthz is exempt, and /mcp shares the same bucket
    expect((await h.req('/healthz')).status).toBe(200);
    expect((await h.req('/mcp', { method: 'POST', headers: MCP, body: INIT })).status).toBe(429);
  });

  it('different anonymous clients (proxy headers trusted) have independent buckets', async () => {
    const h = harness({ trustProxyHeaders: true, rateLimits: { anonymous: { capacity: 1, refillPerSecond: 0.01 }, tiers: {} } });
    const get = (ip: string) => h.req('/v1/providers', { headers: { 'cf-connecting-ip': ip } });
    expect((await get('203.0.113.1')).status).toBe(200);
    expect((await get('203.0.113.1')).status).toBe(429);
    expect((await get('203.0.113.2')).status).toBe(200);
    // proxy headers are ignored unless trusted
    const h2 = harness({ rateLimits: { anonymous: { capacity: 1, refillPerSecond: 0.01 }, tiers: {} } });
    const get2 = (ip: string) => h2.req('/v1/providers', { headers: { 'x-forwarded-for': ip } });
    expect((await get2('1.1.1.1')).status).toBe(200);
    expect((await get2('2.2.2.2')).status).toBe(429);
  });

  it('the token bucket refills over time and evicts old keys', async () => {
    const b = new InMemoryTokenBucket(2);
    const lim = { capacity: 2, refillPerSecond: 1 };
    expect((await b.take('a', lim, 0)).allowed).toBe(true);
    expect((await b.take('a', lim, 0)).allowed).toBe(true);
    const denied = await b.take('a', lim, 0);
    expect(denied).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 1 });
    expect((await b.take('a', lim, 1000)).allowed).toBe(true);
    await b.take('b', lim, 1000);
    await b.take('c', lim, 1000);
    expect(((b as any).buckets as Map<string, unknown>).size).toBeLessThanOrEqual(2);
  });

  it('a pluggable RateLimiter is honoured', async () => {
    const seen: string[] = [];
    const h = harness({}, { limiter: { take: async (key) => (seen.push(key), { allowed: false, limit: 1, remaining: 0, resetSeconds: 5, retryAfterSeconds: 5 }) } });
    expect((await h.req('/v1/providers')).status).toBe(429);
    expect(seen[0]).toMatch(/^ip:[0-9a-f]{24}$/);
  });
});

describe('API keys', () => {
  const config = {
    allowAnonymous: true,
    apiKeys: [
      { id: 'alice', key: 'alice-secret', tier: 'pro' },
      { id: 'bob', key: 'bob-secret', tier: 'standard' },
    ],
    rateLimits: { anonymous: { capacity: 1, refillPerSecond: 0.01 }, tiers: { standard: { capacity: 2, refillPerSecond: 0.01 }, pro: { capacity: 5, refillPerSecond: 0.01 } } },
  };

  it('accepts Bearer and x-api-key, applies the key tier bucket', async () => {
    const h = harness(config);
    const bearer = (k: string) => h.req('/v1/providers', { headers: { authorization: `Bearer ${k}` } });
    const rsB = await Promise.all([1, 2, 3].map(() => bearer('bob-secret')));
    expect(rsB.map((r) => r.status)).toEqual([200, 200, 429]);
    expect(rsB[0]!.headers.get('ratelimit-limit')).toBe('2');
    const rsA = [];
    for (let i = 0; i < 6; i++) rsA.push((await h.req('/v1/providers', { headers: { 'x-api-key': 'alice-secret' } })).status);
    expect(rsA).toEqual([200, 200, 200, 200, 200, 429]);
    // keyed traffic does not consume the anonymous bucket
    expect((await h.req('/v1/providers')).status).toBe(200);
    expect((await h.req('/v1/providers')).status).toBe(429);
  });

  it('an invalid key is 401 even when anonymous access is allowed; no key is 401 when anonymous is off', async () => {
    const h = harness(config);
    const bad = await h.req('/v1/providers', { headers: { authorization: 'Bearer nope' } });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toMatch(/Bearer/);
    expect((await err(bad)).code).toBe('unauthorized');
    const h2 = harness({ ...config, allowAnonymous: false });
    expect((await h2.req('/v1/providers')).status).toBe(401);
    expect((await h2.req('/mcp', { method: 'POST', headers: MCP, body: INIT })).status).toBe(401);
    expect((await h2.req('/v1/providers', { headers: { 'x-api-key': 'bob-secret' } })).status).toBe(200);
    expect((await h2.req('/healthz')).status).toBe(200);
  });

  it('never logs keys', async () => {
    const h = harness(config);
    await h.req('/v1/providers', { headers: { authorization: 'Bearer alice-secret' } });
    await h.req('/v1/providers', { headers: { authorization: 'Bearer wrong-secret' } });
    const logs = h.logs.join('\n');
    expect(logs).not.toMatch(/alice-secret|wrong-secret/);
    expect(logs).toContain('"client_id":"alice"');
  });

  it('key store compares digests in constant time and config parsing handles tiers', async () => {
    const s = new ApiKeyStore(config.apiKeys);
    expect((await s.lookup('alice-secret'))?.id).toBe('alice');
    expect(await s.lookup('alice-secret ')).toBeNull();
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    expect(parseApiKeys('alice=s3@pro, bob=0x, plain')).toEqual([
      { id: 'alice', key: 's3', tier: 'pro' },
      { id: 'bob', key: '0x', tier: 'standard' },
      { id: 'key3', key: 'plain', tier: 'standard' },
    ]);
    const c = configFromEnv({ ALLOW_ANONYMOUS: 'false', API_KEYS: 'a=k', ALLOWED_ORIGINS: 'https://a.example, https://b.example', RATE_LIMIT_ANON_PER_MIN: '6' });
    expect(c).toMatchObject({ allowAnonymous: false, allowedOrigins: ['https://a.example', 'https://b.example'] });
    expect(c.rateLimits.anonymous).toEqual({ capacity: 6, refillPerSecond: 0.1 });
    expect(c.rateLimits.tiers.pro).toBeDefined();
  });
});

describe('limits and failure handling', () => {
  it('rejects oversized bodies with 413 (declared and streamed)', async () => {
    const h = harness({ maxBodyBytes: 200 });
    const big = JSON.stringify({ origin: { stop_id: 'a'.repeat(500) }, destination: { stop_id: 'b' } });
    const r = await h.req('/v1/journeys/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: big });
    expect(r.status).toBe(413);
    expect((await err(r)).code).toBe('payload_too_large');
    const m = await h.req('/mcp', { method: 'POST', headers: MCP, body: JSON.stringify({ pad: 'x'.repeat(500), ...JSON.parse(INIT) }) });
    expect(m.status).toBe(413);
  });

  it('times out slow handlers with 504', async () => {
    const q = fakeQueries();
    q.listProviders.mockImplementation(() => new Promise(() => undefined));
    const h = harness({ requestTimeoutMs: 30 }, { queries: q });
    const r = await h.req('/v1/providers');
    expect(r.status).toBe(504);
    expect((await err(r)).code).toBe('timeout');
  });

  it('never exposes stack traces or upstream URLs, on REST or MCP', async () => {
    const h = harness();
    const rest = await (await h.req('/v1/stops/lmt:stop:boom/arrivals')).text();
    const mcp = await (await h.req('/mcp', { method: 'POST', headers: MCP, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_arrivals', arguments: { stop_id: 'lmt:stop:boom' } } }) })).text();
    for (const body of [rest, mcp]) {
      expect(body).not.toMatch(/\bat \/srv|stack|neon\.internal|SELECT|node_modules|https?:\/\/(?!json-schema)/);
    }
  });
});
