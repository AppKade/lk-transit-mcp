import { describe, expect, it } from 'vitest';
import { createJsonLogger, redact, redactString } from '../src/logger.js';
import { harness } from './helpers.js';

const MCP = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
// Coordinates that must never appear in any log line, in any formatting.
const LAT = '6.927079';
const LON = '79.861244';
const COORD_RE = /6\.927079|79\.861244|6\.9270|79\.8612/;

describe('privacy-safe logging', () => {
  it('requests carrying coordinates (REST query, REST body, MCP body) leave no coordinates in logs', async () => {
    const h = harness();
    await h.req(`/v1/stops/nearby?latitude=${LAT}&longitude=${LON}&radius_m=500`);
    await h.req(`/v1/vehicles?bbox=${LON},${LAT},80,7`);
    await h.req(`/v1/stops/nearby?latitude=${LAT}&longitude=999`); // invalid -> 400 path
    await h.req('/v1/journeys/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: { latitude: +LAT, longitude: +LON }, destination: { stop_id: 'lmt:stop:22' } }) });
    await h.req('/mcp', { method: 'POST', headers: MCP, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_stops_nearby', arguments: { latitude: +LAT, longitude: +LON } } }) });
    await h.req('/mcp', { method: 'POST', headers: MCP, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'find_stops_nearby', arguments: { latitude: +LAT } } }) }); // invalid args
    await h.req(`/v1/nope?latitude=${LAT}&longitude=${LON}`);
    const all = h.logs.join('\n');
    expect(h.logs.length).toBeGreaterThanOrEqual(7);
    expect(all).not.toMatch(COORD_RE);
    expect(all).not.toMatch(/latitude|longitude|radius_m|bbox/);
  });

  it('logs only operational fields: route template, status, latency, provider, tool, trace id', async () => {
    const h = harness();
    await h.req('/v1/stops/lmt:stop:22/arrivals?within_minutes=30');
    await h.req('/mcp', { method: 'POST', headers: MCP, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_arrivals', arguments: { stop_id: 'lmt:stop:missing' } } }) });
    const recs = h.logs.map((l) => JSON.parse(l));
    expect(recs[0]).toMatchObject({ event: 'http_request', method: 'GET', route: '/v1/stops/:stop_id/arrivals', status: 200, provider: 'lmt', tier: 'anonymous' });
    expect(typeof recs[0].latency_ms).toBe('number');
    expect(recs[0].trace_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(recs[0])).not.toContain('lmt:stop:22'); // route template, not the concrete path
    expect(recs[1]).toMatchObject({ route: '/mcp', status: 200, tool: 'get_arrivals', error_code: 'unknown_stop' });
    expect(Object.keys(recs[0]).sort()).toEqual(['client_id', 'event', 'latency_ms', 'level', 'method', 'provider', 'route', 'status', 'tier', 'trace_id', 'ts'].filter((k) => k in recs[0]).sort());
  });

  it('unmatched paths are logged as a constant, not the attacker-chosen path', async () => {
    const h = harness();
    await h.req('/v1/zzz-secret-path?q=1');
    expect(JSON.parse(h.logs[0]!).route).toBe('(unmatched)');
    expect(h.logs.join('')).not.toContain('zzz-secret-path');
  });

  it('redact() drops sensitive keys and scrubs coordinate-looking strings and tokens', () => {
    const out = JSON.stringify(
      redact({
        latitude: 6.927079,
        nested: { longitude: 79.861244, ok: 'fine', arr: [{ lat: 1 }] },
        msg: 'failed for 6.927079,79.861244 and ?latitude=6.927079&longitude=79.861244 with Bearer abc.def-123',
        n: 6.927079,
        status: 200,
        latency: 12.3,
        authorization: 'Bearer x',
        url: 'https://api.transit.seyone.dev/x',
      }),
    );
    expect(out).not.toMatch(COORD_RE);
    expect(out).not.toMatch(/abc\.def|seyone|Bearer x/);
    expect(out).toContain('fine');
    expect(out).toContain('"status":200');
    expect(out).toContain('12.3');
    expect(redactString('stop 22 at 6.9,79.8')).toBe('stop 22 at 6.9,79.8'); // short, imprecise numbers are not coordinates
  });

  it('the JSON logger redacts even if a caller passes coordinates by mistake', () => {
    const lines: string[] = [];
    createJsonLogger((l) => lines.push(l)).log('info', 'oops', { params: { latitude: 6.927079 }, note: 'at 6.927079, 79.861244' });
    expect(lines[0]).not.toMatch(COORD_RE);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', event: 'oops' });
  });
});
