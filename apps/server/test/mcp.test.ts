import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { harness, type Harness } from './helpers.js';

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

async function connect(h: Harness, headers: Record<string, string> = {}) {
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: ((url: string | URL, init?: RequestInit) => Promise.resolve(h.app.request(url.toString(), init))) as typeof fetch,
    requestInit: { headers },
  });
  await client.connect(transport);
  return client;
}

const rpc = (h: Harness, body: unknown, headers: Record<string, string> = {}) =>
  h.req('/mcp', { method: 'POST', headers: { ...MCP_HEADERS, ...headers }, body: JSON.stringify(body) });

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };

describe('MCP over Streamable HTTP', () => {
  it('raw JSON-RPC: initialize returns server info, capabilities, instructions, and no session id', async () => {
    const r = await rpc(harness(), INIT);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(r.headers.get('mcp-session-id')).toBeNull();
    const b = (await r.json()) as any;
    expect(b.result.serverInfo.name).toBe('lk-transit-mcp');
    expect(b.result.protocolVersion).toBe('2025-06-18');
    expect(b.result.capabilities).toHaveProperty('tools');
    expect(b.result.capabilities).toHaveProperty('resources');
    expect(b.result.instructions).toMatch(/prediction_type/);
  });

  it('negotiates down to a supported version when the client asks for an unknown one', async () => {
    const r = await rpc(harness(), { ...INIT, params: { ...INIT.params, protocolVersion: '2026-07-28' } });
    expect(((await r.json()) as any).result.protocolVersion).toBe('2025-11-25');
  });

  it('rejects an unsupported MCP-Protocol-Version header with 400 and accepts a supported one', async () => {
    const h = harness();
    const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
    expect((await rpc(h, list, { 'mcp-protocol-version': '1999-01-01' })).status).toBe(400);
    expect((await rpc(h, list, { 'mcp-protocol-version': '2025-06-18' })).status).toBe(200);
    expect((await rpc(h, list)).status).toBe(200); // header absent: SDK accepts (spec: assume 2025-03-26)
  });

  it('requires JSON content type and both Accept types; notifications get 202', async () => {
    const h = harness();
    expect((await h.req('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(INIT) })).status).toBe(406);
    expect((await h.req('/mcp', { method: 'POST', headers: { ...MCP_HEADERS, 'content-type': 'text/plain' }, body: JSON.stringify(INIT) })).status).toBe(415);
    expect((await h.req('/mcp', { method: 'POST', headers: MCP_HEADERS, body: '{oops' })).status).toBe(400);
    expect((await rpc(h, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
  });

  it('GET and DELETE /mcp return 405 (stateless, no SSE)', async () => {
    const h = harness();
    for (const method of ['GET', 'DELETE']) {
      const r = await h.req('/mcp', { method, headers: { accept: 'text/event-stream' } });
      expect(r.status, method).toBe(405);
      expect(r.headers.get('allow')).toBe('POST');
    }
  });

  it('SDK client: tools/list returns the 8 tools with valid 2020-12 schemas and read-only annotations', async () => {
    const client = await connect(harness());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['find_stops_nearby', 'get_arrivals', 'get_feed_status', 'get_route', 'get_service_alerts', 'get_vehicle_positions', 'plan_trip', 'search_routes'],
    );
    for (const t of tools) {
      expect(t.description!.length, t.name).toBeGreaterThan(80);
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.additionalProperties, t.name).toBe(false);
      expect((t.inputSchema as any).$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(JSON.stringify(t.inputSchema)).not.toMatch(/\$ref|"items":\[/);
      expect(t.outputSchema?.type).toBe('object');
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    }
    const nearby = tools.find((t) => t.name === 'find_stops_nearby')!;
    expect(nearby.inputSchema.required).toEqual(['latitude', 'longitude']);
    expect((nearby.inputSchema as any).properties.radius_m).toMatchObject({ minimum: 50, maximum: 5000, default: 800 });
    const veh = tools.find((t) => t.name === 'get_vehicle_positions')!;
    expect((veh.inputSchema as any).properties.bbox).toMatchObject({ type: 'array', prefixItems: expect.any(Array), items: false });
    expect(tools.find((t) => t.name === 'get_arrivals')!.description).toMatch(/scheduled.*provider_live|prediction_type/s);
    await client.close();
  });

  it('SDK client: tools/call success returns structuredContent with the envelope and a text fallback', async () => {
    const h = harness();
    const client = await connect(h);
    const res = await client.callTool({ name: 'get_arrivals', arguments: { stop_id: 'lmt:stop:22' } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc).toMatchObject({ provider: 'lmt', freshness: { status: 'fresh' }, source: { type: 'gtfs_realtime', license: 'CC-BY-4.0', attribution: expect.any(String) } });
    expect(sc.as_of).toMatch(/\+05:30$/);
    expect(sc.data[0].prediction_type).toBe('provider_live');
    const text = (res.content as any[])[0].text as string;
    expect(text).toContain('provider=lmt');
    expect(text).toContain('freshness=fresh');
    expect(text).toContain('provider_live');
    expect(text.length).toBeLessThan(JSON.stringify(sc).length);
    expect(h.queries.getArrivals).toHaveBeenCalledWith({ stop_id: 'lmt:stop:22', within_minutes: 60, limit: 20 });
    await client.close();
  });

  it('SDK client: every tool can be called', async () => {
    const client = await connect(harness());
    const calls: Record<string, unknown> = {
      find_stops_nearby: { latitude: 6.84, longitude: 79.97 },
      get_arrivals: { stop_id: 's' },
      get_vehicle_positions: { bbox: [79.8, 6.8, 80, 7] },
      search_routes: { query: 'cm01' },
      get_route: { route_id: 'lmt:route:cm01' },
      plan_trip: { origin: { stop_id: 'a' }, destination: { latitude: 6.9, longitude: 79.8 } },
      get_service_alerts: {},
      get_feed_status: {},
    };
    for (const [name, args] of Object.entries(calls)) {
      const res = await client.callTool({ name, arguments: args as Record<string, unknown> });
      expect(res.isError, name).toBeFalsy();
      expect((res.structuredContent as any).provider, name).toBe('lmt');
      expect(((res.content as any[])[0].text as string).length, name).toBeGreaterThan(20);
    }
    await client.close();
  });

  it('invalid arguments (incl. out-of-range, unknown keys) give isError with structured invalid_argument', async () => {
    const client = await connect(harness());
    for (const [name, args] of [
      ['find_stops_nearby', { latitude: 6.84 }],
      ['find_stops_nearby', { latitude: 91, longitude: 79 }],
      ['find_stops_nearby', { latitude: 6.8, longitude: 79.9, radius_m: 100000 }],
      ['get_arrivals', { stop_id: 's', extra: true }],
      ['plan_trip', { origin: {}, destination: { stop_id: 'b' } }],
    ] as const) {
      const res = await client.callTool({ name, arguments: args as Record<string, unknown> });
      expect(res.isError, name).toBe(true);
      expect((res.structuredContent as any).error.code).toBe('invalid_argument');
      expect(((res.content as any[])[0].text as string)).toMatch(/invalid_argument/);
    }
    await client.close();
  });

  it('a ToolError becomes isError with {error:{code,message}} the model can act on', async () => {
    const client = await connect(harness());
    const res = await client.callTool({ name: 'get_arrivals', arguments: { stop_id: 'lmt:stop:missing' } });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as any).error).toMatchObject({ code: 'unknown_stop', message: expect.stringContaining('find_stops_nearby') });
    const down = await client.callTool({ name: 'get_arrivals', arguments: { stop_id: 'lmt:stop:down' } });
    expect((down.structuredContent as any).error.code).toBe('provider_unavailable');
    expect(JSON.stringify(down)).not.toMatch(/internal\.example|token=abc/);
    const boom = await client.callTool({ name: 'get_arrivals', arguments: { stop_id: 'lmt:stop:boom' } });
    expect(boom.isError).toBe(true);
    expect((boom.structuredContent as any).error).toEqual({ code: 'internal', message: 'Internal error' });
    await client.close();
  });

  it('unknown tool name is a JSON-RPC error', async () => {
    const client = await connect(harness());
    await expect(client.callTool({ name: 'drop_tables', arguments: {} })).rejects.toThrow(/Unknown tool/);
    await client.close();
  });

  it('resources: list, templates, read', async () => {
    const client = await connect(harness());
    const list = await client.listResources();
    expect(list.resources.map((r) => r.uri)).toEqual(expect.arrayContaining(['transit://providers', 'transit://licenses', 'transit://providers/lmt/status']));
    const tpl = await client.listResourceTemplates();
    expect(tpl.resourceTemplates.map((t) => t.uriTemplate)).toEqual(expect.arrayContaining(['transit://routes/{route_id}', 'transit://providers/{provider}/status']));

    const read = async (uri: string) => JSON.parse(((await client.readResource({ uri })).contents[0] as any).text);
    expect((await read('transit://providers')).data[0].provider).toBe('lmt');
    expect((await read('transit://licenses')).data[0]).toMatchObject({ provider: 'lmt', declared_license: 'CC-BY-4.0', attribution: expect.any(String) });
    expect((await read('transit://providers/lmt/status')).data.overall).toBe('healthy');
    expect((await read('transit://routes/lmt:route:cm01')).data.route.short_name).toBe('CM01');
    await expect(client.readResource({ uri: 'transit://routes/lmt:route:missing' })).rejects.toThrow(/unknown_route/);
    await expect(client.readResource({ uri: 'transit://stops/lmt:stop:22' })).rejects.toThrow(/not found/i);
    await client.close();
  });

  it('works with API-key auth through the SDK client headers', async () => {
    const h = harness({ allowAnonymous: false, apiKeys: [{ id: 'a', key: 'sekret', tier: 'standard' }] });
    await expect(connect(h)).rejects.toThrow();
    const client = await connect(h, { authorization: 'Bearer sekret' });
    expect((await client.listTools()).tools).toHaveLength(8);
    await client.close();
  });
});
