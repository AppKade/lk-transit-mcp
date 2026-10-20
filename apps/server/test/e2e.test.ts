/**
 * Golden path with the real packages: fixture GTFS zip -> static ingest -> RealtimeHub (replayed fixture payloads)
 * -> createTransitQueries -> REST and MCP. Only the network is faked.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LMT, PROVIDERS } from '@lkt/core';
import { createPgliteDb, migrate } from '@lkt/db';
import { RealtimeHub, ensureProvider, runStaticIngest } from '@lkt/ingest';
import { createTransitQueries } from '@lkt/query';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { defineConfig } from '../src/config.js';
import { createJsonLogger } from '../src/logger.js';

const dir = fileURLToPath(new URL('../../../fixtures/lmt/', import.meta.url));
const file = (n: string) => new Uint8Array(readFileSync(dir + n));
// Capture time of the fixtures (epoch ms) plus 15 s.
const T0 = 1792499745_000;

let app: ReturnType<typeof createApp>;
let close: () => Promise<void>;
const logs: string[] = [];

beforeAll(async () => {
  const db = await createPgliteDb();
  await migrate(db);
  await ensureProvider(db, LMT);
  const clock = { now: () => T0 };
  const ingest = await runStaticIngest(
    { db, provider: LMT, clock, fetchImpl: (async () => new Response(file('gtfs.zip'))) as typeof fetch },
    {},
  );
  expect(ingest.status).toBe('activated');
  const feeds: Record<string, string> = { vehicle_positions: 'vehicle-positions.pb', trip_updates: 'trip-updates.pb', alerts: 'alerts.pb' };
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    const key = Object.keys(feeds).find((k) => u.includes(k.replace('_', '-')));
    return new Response(file(feeds[key!]!));
  }) as typeof fetch;
  const hub = new RealtimeHub({ provider: LMT, db, clock, fetchImpl });
  await hub.pollOnce();
  const queries = createTransitQueries({ db, realtime: hub, clock, providers: PROVIDERS, defaultProvider: LMT.id });
  app = createApp({ queries, clock, config: defineConfig(), log: createJsonLogger((l) => logs.push(l)) });
  close = () => db.close();
}, 60_000);

afterAll(() => close?.());

const get = async (path: string) => app.request(`http://localhost${path}`);

describe('real query layer behind REST + MCP', () => {
  it('REST: nearby stops -> arrivals -> route, all enveloped with provenance', async () => {
    const near = await get('/v1/stops/nearby?latitude=6.8421&longitude=79.9712&radius_m=3000&limit=3');
    expect(near.status).toBe(200);
    const nb = (await near.json()) as any;
    expect(nb).toMatchObject({ provider: 'lmt', source: { type: 'gtfs_static', license: 'CC-BY-4.0', url_ref: ['lmt.gtfs'] } });
    expect(nb.data.length).toBeGreaterThan(0);
    const stop = nb.data[0];
    expect(stop.stop_id).toMatch(/^lmt:stop:/);

    const arr = await get(`/v1/stops/${stop.stop_id}/arrivals?within_minutes=180`);
    expect(arr.status).toBe(200);
    const ab = (await arr.json()) as any;
    expect(ab.as_of).toMatch(/\+05:30$/);
    expect(['scheduled', 'provider_live', 'derived_live', 'stale']).toContain(ab.data[0]?.prediction_type ?? 'scheduled');

    const r = (await (await get('/v1/routes?query=CM01')).json()) as any;
    const routeId = r.data[0].route_id as string;
    const detail = await get(`/v1/routes/${routeId}`);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as any).data.directions.length).toBeGreaterThan(0);

    expect((await get('/v1/stops/lmt:stop:does-not-exist/arrivals')).status).toBe(404);
  });

  it('REST: live vehicles and feed status are fresh at capture time', async () => {
    const v = (await (await get('/v1/vehicles')).json()) as any;
    expect(v.source.type).toBe('gtfs_realtime');
    expect(v.freshness.status).toBe('fresh');
    expect(v.data.length).toBeGreaterThan(0);
    const h = (await (await get('/v1/health/providers')).json()) as any;
    expect(h.providers[0].status.data.overall).toBe('healthy');
    expect(((await (await get('/v1/provenance/lmt')).json()) as any).license.provider_authority).toBe('unconfirmed');
  });

  it('MCP: the headline questions work through tools/call', async () => {
    const client = new Client({ name: 'e2e', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        fetch: ((u: string | URL, init?: RequestInit) => Promise.resolve(app.request(u.toString(), init))) as typeof fetch,
      }),
    );
    const near = await client.callTool({ name: 'find_stops_nearby', arguments: { latitude: 6.8421, longitude: 79.9712, radius_m: 3000 } });
    expect(near.isError).toBeFalsy();
    const stopId = (near.structuredContent as any).data[0].stop_id as string;
    const arr = await client.callTool({ name: 'get_arrivals', arguments: { stop_id: stopId, within_minutes: 180 } });
    expect(arr.isError).toBeFalsy();
    expect((arr.structuredContent as any).freshness).toHaveProperty('status');
    const veh = await client.callTool({ name: 'get_vehicle_positions', arguments: {} });
    expect((veh.structuredContent as any).data.length).toBeGreaterThan(0);
    const status = await client.callTool({ name: 'get_feed_status', arguments: {} });
    expect((status.structuredContent as any).data.overall).toBe('healthy');
    const bad = await client.callTool({ name: 'get_arrivals', arguments: { stop_id: 'lmt:stop:nope' } });
    expect(bad.isError).toBe(true);
    expect((bad.structuredContent as any).error.code).toBe('unknown_stop');
    const res = JSON.parse(((await client.readResource({ uri: 'transit://licenses' })).contents[0] as any).text);
    expect(res.data[0].attribution).toMatch(/Lanka Metro Transit/);
    await client.close();
  });

  it('logs from the real stack contain no coordinates', () => {
    expect(logs.join('\n')).not.toMatch(/6\.8421|79\.9712/);
  });
});
