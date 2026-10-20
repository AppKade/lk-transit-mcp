import { describe, expect, it } from 'vitest';
import { harness } from './helpers.js';

const json = async (r: Response) => (await r.json()) as any;

describe('REST /v1', () => {
  it('GET /healthz works with no dependencies and no auth', async () => {
    const h = harness({ allowAnonymous: false });
    const r = await h.req('/healthz');
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ status: 'ok' });
    expect(h.queries.listProviders).not.toHaveBeenCalled();
  });

  it('GET /v1/providers', async () => {
    const r = await harness().req('/v1/providers');
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b.data[0]).toMatchObject({ provider: 'lmt', timezone: 'Asia/Colombo' });
    expect(b.data[0].license.declared_license).toBe('CC-BY-4.0');
  });

  it('GET /v1/stops/nearby coerces numeric query strings and returns the envelope', async () => {
    const h = harness();
    const r = await h.req('/v1/stops/nearby?latitude=6.8421&longitude=79.9712&radius_m=500&limit=3');
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b).toMatchObject({ provider: 'lmt', freshness: { status: 'fresh' }, source: { type: 'gtfs_static', license: 'CC-BY-4.0' } });
    expect(b.as_of).toMatch(/\+05:30$/);
    expect(h.queries.findStopsNearby).toHaveBeenCalledWith({ latitude: 6.8421, longitude: 79.9712, radius_m: 500, limit: 3 });
  });

  it('applies schema defaults and rejects bad nearby input with 400 invalid_argument', async () => {
    const h = harness();
    await h.req('/v1/stops/nearby?latitude=6.8&longitude=79.9');
    expect(h.queries.findStopsNearby).toHaveBeenCalledWith({ latitude: 6.8, longitude: 79.9, radius_m: 800, limit: 10 });
    for (const qs of ['latitude=abc&longitude=79', 'latitude=6.8', 'latitude=91&longitude=79', 'latitude=6&longitude=79&radius_m=99999', 'latitude=6&longitude=79&radius_m=1e3', 'latitude=6&longitude=79&bogus=1', 'latitude=6&latitude=7&longitude=79']) {
      const r = await h.req(`/v1/stops/nearby?${qs}`);
      expect(r.status, qs).toBe(400);
      const b = await json(r);
      expect(b.error.code).toBe('invalid_argument');
      expect(b.error.message).toBeTruthy();
      expect(b.error.details.issues.length).toBeGreaterThan(0);
    }
  });

  it('GET /v1/stops/{id}/arrivals passes the (colon-containing) id and exposes prediction_type', async () => {
    const h = harness();
    const r = await h.req('/v1/stops/lmt:stop:22/arrivals?within_minutes=30&route_id=lmt:route:cm01');
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b.data.map((a: any) => a.prediction_type)).toEqual(['provider_live', 'scheduled']);
    expect(h.queries.getArrivals).toHaveBeenCalledWith({ stop_id: 'lmt:stop:22', within_minutes: 30, route_id: 'lmt:route:cm01', limit: 20 });
    expect((await h.req('/v1/stops/lmt:stop:22/arrivals?within_minutes=500')).status).toBe(400);
  });

  it('GET /v1/routes (search) and /v1/routes/{id}', async () => {
    const h = harness();
    expect((await h.req('/v1/routes?query=cm01&limit=5')).status).toBe(200);
    expect(h.queries.searchRoutes).toHaveBeenCalledWith({ query: 'cm01', limit: 5 });
    expect((await h.req('/v1/routes')).status).toBe(400);
    const r = await h.req('/v1/routes/lmt:route:cm01?direction_id=1');
    expect(r.status).toBe(200);
    expect(h.queries.getRoute).toHaveBeenCalledWith({ route_id: 'lmt:route:cm01', direction_id: 1 });
    expect((await h.req('/v1/routes/x?direction_id=2')).status).toBe(400);
  });

  it('GET /v1/vehicles parses bbox and max_age_seconds', async () => {
    const h = harness();
    const r = await h.req('/v1/vehicles?bbox=79.8,6.8,80.0,7.0&max_age_seconds=120&route_id=lmt:route:cm01');
    expect(r.status).toBe(200);
    expect(h.queries.getVehiclePositions).toHaveBeenCalledWith({ bbox: [79.8, 6.8, 80, 7], max_age_seconds: 120, route_id: 'lmt:route:cm01' });
    expect((await h.req('/v1/vehicles?bbox=1,2,3')).status).toBe(400);
    expect((await h.req('/v1/vehicles?bbox=79.8,95,80,7')).status).toBe(400);
  });

  it('GET /v1/alerts', async () => {
    const h = harness();
    const r = await h.req('/v1/alerts?route_id=lmt:route:cm01');
    expect(r.status).toBe(200);
    expect((await json(r)).freshness.threshold_seconds).toBe(600);
  });

  it('POST /v1/journeys/plan validates the body', async () => {
    const h = harness();
    const post = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
      h.req('/v1/journeys/plan', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const ok = await post({ origin: { stop_id: 'lmt:stop:22' }, destination: { latitude: 6.93, longitude: 79.85 } });
    expect(ok.status).toBe(200);
    expect(h.queries.planTrip).toHaveBeenCalledWith(expect.objectContaining({ max_transfers: 1, wheelchair_accessible: false }));
    expect((await post({ origin: {}, destination: { stop_id: 'a' } })).status).toBe(400);
    expect((await post({ origin: { stop_id: 'a' }, destination: { stop_id: 'b' }, extra: 1 })).status).toBe(400);
    expect((await post('{not json')).status).toBe(400);
    expect((await post('{}', { 'content-type': 'text/plain' })).status).toBe(415);
  });

  it('GET /v1/health/providers and /v1/provenance/{provider}', async () => {
    const h = harness();
    const hp = await json(await h.req('/v1/health/providers'));
    expect(hp.providers[0]).toMatchObject({ provider: 'lmt', status: { data: { overall: 'healthy' } } });
    const pv = await h.req('/v1/provenance/lmt');
    expect(pv.status).toBe(200);
    const b = await json(pv);
    expect(b).toMatchObject({ provider: 'lmt', license: { declared_license: 'CC-BY-4.0', provider_authority: 'unconfirmed' }, source: { url_ref: expect.any(Array) } });
    expect(JSON.stringify(b)).not.toMatch(/https?:\/\/api\.transit/);
    const nf = await h.req('/v1/provenance/nope');
    expect(nf.status).toBe(404);
    expect((await json(nf)).error.code).toBe('unknown_provider');
  });

  it('maps ToolError codes to HTTP statuses and never leaks internals', async () => {
    const h = harness();
    const miss = await h.req('/v1/stops/lmt:stop:missing/arrivals');
    expect(miss.status).toBe(404);
    expect((await json(miss)).error.code).toBe('unknown_stop');
    expect((await h.req('/v1/routes/lmt:route:missing')).status).toBe(404);

    const down = await h.req('/v1/stops/lmt:stop:down/arrivals');
    expect(down.status).toBe(503);
    const dtxt = JSON.stringify(await json(down));
    expect(dtxt).toContain('provider_unavailable');
    expect(dtxt).not.toMatch(/internal\.example|token=abc/);

    const boom = await h.req('/v1/stops/lmt:stop:boom/arrivals');
    expect(boom.status).toBe(500);
    const btxt = await boom.text();
    expect(JSON.parse(btxt)).toEqual({ error: { code: 'internal', message: 'Internal error' } });
    expect(btxt).not.toMatch(/SELECT|neon|stack|\bat \/|6\.92714/);
    expect(h.logs.join('\n')).not.toMatch(/SELECT|neon\.internal|6\.92714/);
  });

  it('unknown routes are 404 JSON errors', async () => {
    const r = await harness().req('/v1/nope');
    expect(r.status).toBe(404);
    expect((await json(r)).error.code).toBe('not_found');
  });
});
