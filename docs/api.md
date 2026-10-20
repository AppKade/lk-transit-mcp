# REST and MCP API

One server (`apps/server`) exposes the same eight read-only capabilities two ways: a REST API under `/v1` and an MCP
endpoint at `/mcp`. Both validate input with the same Zod schemas (`packages/core/src/schemas.ts`) and return the same
envelope, so there is one definition of each contract.

| Path | Purpose |
|---|---|
| `POST /mcp` | MCP, stateless Streamable HTTP (JSON-RPC in, JSON out) |
| `GET /v1/...`, `POST /v1/journeys/plan` | REST mirror |
| `GET /healthz` | Liveness only; touches no dependencies, needs no key, not rate limited |
| `GET /` | Name, version and entry points |

## Response envelope

Every query response (REST body, MCP `structuredContent`) looks like this. Cite `provider`, `source` and `as_of` when
presenting an answer.

```json
{
  "provider": "lmt",
  "as_of": "2026-10-20T18:22:40+05:30",
  "freshness": { "status": "fresh", "age_seconds": 12, "threshold_seconds": 90 },
  "source": {
    "type": "gtfs_realtime",
    "url_ref": ["lmt.vehicle_positions"],
    "feed_version": "2026-10-20T12:52Z-398829",
    "license": "CC-BY-4.0",
    "license_status": "registry_declared_pending_provider_confirmation",
    "provider_authority": "unconfirmed",
    "attribution": "Lanka Metro Transit GTFS data via api.transit.seyone.dev (community feed), CC-BY-4.0"
  },
  "data": []
}
```

- `freshness.status`: `fresh` | `stale` | `unavailable`. Stale or unavailable live data must not be presented as live.
- `url_ref` is a configured source key, never the upstream URL.
- Arrival rows carry `prediction_type`: `scheduled` (timetable only), `provider_live` (fresh upstream TripUpdate),
  `derived_live` (computed from fresh GPS), `stale` (live data too old; use `scheduled_time`).

## REST

Query-string values are coerced to numbers where the schema expects them, then validated with the shared schemas
(unknown parameters are rejected). All responses are `application/json`, `Cache-Control: no-store`.

| Endpoint | Parameters | MCP tool |
|---|---|---|
| `GET /v1/providers` | none | resource `transit://providers` |
| `GET /v1/stops/nearby` | `latitude`, `longitude` (required), `radius_m` 50-5000 (800), `limit` 1-50 (10), `provider` | `find_stops_nearby` |
| `GET /v1/stops/{stop_id}/arrivals` | `within_minutes` 1-180 (60), `route_id`, `limit` 1-100 (20), `provider` | `get_arrivals` |
| `GET /v1/routes` | `query` (required), `limit` 1-50 (10), `provider` | `search_routes` |
| `GET /v1/routes/{route_id}` | `direction_id` 0 or 1 | `get_route` |
| `GET /v1/vehicles` | `route_id`, `trip_id`, `bbox=west,south,east,north`, `max_age_seconds` 1-600 (90), `provider` | `get_vehicle_positions` |
| `GET /v1/alerts` | `route_id`, `stop_id`, `provider` | `get_service_alerts` |
| `POST /v1/journeys/plan` | JSON body, see below | `plan_trip` |
| `GET /v1/health/providers` | none | `get_feed_status` for every provider |
| `GET /v1/provenance/{provider}` | none | licence, authority, attribution, current feed version |

There is no `GET /v1/stops/{id}` yet (the query layer has no stop getter), and so no `transit://stops/{id}` resource.

```bash
curl 'https://HOST/v1/stops/nearby?latitude=6.8421&longitude=79.9712&radius_m=800&limit=2'
```
```json
{
  "provider": "lmt", "as_of": "2026-10-20T18:22:40+05:30",
  "freshness": { "status": "fresh", "age_seconds": 37, "threshold_seconds": 2592000 },
  "source": { "type": "gtfs_static", "url_ref": ["lmt.gtfs"], "feed_version": "2026-10-20T12:52Z-398829", "license": "CC-BY-4.0", "...": "..." },
  "data": [
    { "stop_id": "lmt:stop:41", "name": "Makumbura", "code": "MCC62", "latitude": 6.84051, "longitude": 79.97562,
      "distance_m": 519, "routes": [{ "route_id": "lmt:route:8bc594e3-...", "short_name": "CM01", "long_name": "CM01 (Makumbura - Colombo Fort)" }] }
  ]
}
```
```bash
curl 'https://HOST/v1/stops/lmt:stop:41/arrivals?within_minutes=30'
```
```json
{ "provider": "lmt", "as_of": "...", "freshness": { "status": "fresh", "age_seconds": 12, "threshold_seconds": 90 }, "source": { "...": "..." },
  "data": [
    { "route": { "route_id": "lmt:route:...", "short_name": "CM01", "long_name": "..." }, "headsign": "Colombo Fort",
      "scheduled_time": "2026-10-20T18:30:00+05:30", "estimated_time": "2026-10-20T18:32:00+05:30",
      "delay_seconds": 120, "minutes_until": 7, "prediction_type": "provider_live", "live_age_seconds": 12 } ] }
```
```bash
curl -X POST https://HOST/v1/journeys/plan -H 'content-type: application/json' -d '{
  "origin": {"stop_id": "lmt:stop:41"}, "destination": {"latitude": 6.9344, "longitude": 79.8428},
  "departure_time": "2026-10-20T18:30:00+05:30", "max_transfers": 1 }'
```
(`plan_trip` returns `internal` "not implemented yet" until the planner lands in `packages/query`.)

### Errors

All errors, REST and MCP, have one shape: `{"error": {"code", "message", "details?"}}`.

| `code` | HTTP | Meaning / what to do |
|---|---|---|
| `invalid_argument` | 400 | Schema violation; `details.issues[]` lists `path` and `message` (values are never echoed) |
| `unauthorized` | 401 | Missing or invalid API key (`WWW-Authenticate: Bearer`) |
| `forbidden` | 403 | `Origin` not allowed (on `/mcp`) |
| `unknown_stop` / `unknown_route` / `unknown_provider` / `not_found` | 404 | Look the id up again with `find_stops_nearby` / `search_routes` |
| `method_not_allowed` | 405 | `GET`/`DELETE /mcp` (stateless server) |
| `payload_too_large` / `unsupported_media_type` | 413 / 415 | Body over `maxBodyBytes`, or not `application/json` |
| `rate_limited` | 429 | `Retry-After` header and `details.retry_after_seconds` |
| `internal` | 500 | Generic; the real cause is only in server logs (never stack traces, SQL or upstream URLs) |
| `provider_unavailable` | 503 | Data source or database not usable right now; retry later |
| `timeout` | 504 | Request exceeded `requestTimeoutMs` (default 10 s) |

## MCP

- **Endpoint:** `POST /mcp`, JSON-RPC 2.0. **Stateless**: a fresh server per request, no `Mcp-Session-Id`, replies are
  `application/json` (no SSE). `GET /mcp` and `DELETE /mcp` return `405` with `Allow: POST`.
- Clients must send `Content-Type: application/json` and `Accept: application/json, text/event-stream` (the SDK
  returns 406/415 otherwise).
- **Protocol versions** (MCP TypeScript SDK 1.32.1): `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`,
  `2024-10-07`. A client asking for anything else (e.g. `2026-07-28`) is answered with `2025-11-25` in `initialize`,
  and a non-initialize request carrying an unsupported `MCP-Protocol-Version` header gets `400`. A missing header is
  accepted. `requirement.md` names `2026-07-28`, which this SDK does not know; revisit when the SDK adds it.
- **Origin:** requests with no `Origin` header (CLI/desktop/server clients) are accepted; a browser `Origin` must be in
  `ALLOWED_ORIGINS` or the request gets `403`. With an empty allow-list every browser origin is refused.
- **Auth:** same as REST (`Authorization: Bearer <key>` or `x-api-key`). No OAuth: there is no privileged tool.

### Client configuration

Remote server (Claude Code):
```bash
claude mcp add --transport http lk-transit https://HOST/mcp \
  --header "Authorization: Bearer $LKT_API_KEY"      # header optional while anonymous access is on
```
Generic JSON for hosts that take a remote URL:
```json
{ "mcpServers": { "lk-transit": { "type": "http", "url": "https://HOST/mcp",
  "headers": { "Authorization": "Bearer YOUR_KEY" } } } }
```
Hosts that only speak stdio can bridge with `npx mcp-remote https://HOST/mcp`. Local: `http://127.0.0.1:8787/mcp`.
Inspect with `npx @modelcontextprotocol/inspector` (transport: Streamable HTTP, URL above).

### Tools

All eight are read-only (`readOnlyHint: true`), take JSON Schema 2020-12 input with `additionalProperties: false`, and
return `structuredContent` (the envelope) plus a compact text summary. Descriptions are written for the model: when to
call, how to read `freshness` and `prediction_type`, and what to cite.

| Tool | Use it for |
|---|---|
| `find_stops_nearby` | stop ids near a place or position |
| `get_arrivals` | "when is the next bus" at a stop, with `prediction_type` per row |
| `get_vehicle_positions` | where buses are now (stale vehicles excluded by default) |
| `search_routes` | turn "CM01" / a place name into a `route_id` |
| `get_route` | directions, stop pattern, first/last departure, runs today |
| `plan_trip` | direct and transfer journeys, assumptions returned explicitly |
| `get_service_alerts` | active disruptions |
| `get_feed_status` | is the data current: per-feed freshness, quarantine counts, overall verdict |

A failing call returns a normal result with `isError: true`, a text line `Error [code]: message`, and
`structuredContent: {"error": {"code", "message", "details?"}}` so the model can recover (e.g. `unknown_stop` -> search
again). Invalid arguments are reported the same way (`invalid_argument`), not as JSON-RPC errors. Only an unknown tool
name or a malformed request is a JSON-RPC error. The tool `outputSchema` accepts both the envelope and the error shape.

```bash
curl -s https://HOST/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"get_arrivals","arguments":{"stop_id":"lmt:stop:41","within_minutes":30}}}'
```

### Resources

| URI | Content |
|---|---|
| `transit://providers` | providers, timezone, licence |
| `transit://providers/{provider}/status` | feed status envelope (listed per provider) |
| `transit://licenses` | licence, licence status, provider authority, attribution per provider |
| `transit://routes/{route_id}` | route detail envelope |

## Auth, rate limits, privacy

- **Anonymous** access is allowed when `ALLOW_ANONYMOUS` is true (default). Requests with an API key use that key's tier.
  An invalid key is always `401`; failed attempts consume the anonymous bucket.
- **API keys:** `API_KEYS="alice=s3cret@pro,bob=0ther"` (`name=secret[@tier]`, tier defaults to `standard`). Keys are
  compared as SHA-256 digests in constant time and never logged (the non-secret name is).
- **Rate limits** are token buckets per client: anonymous 30 requests/min (burst 30), `standard` 120, `pro` 600 by
  default; override with `RATE_LIMIT_ANON_PER_MIN` / `RATE_LIMIT_KEY_PER_MIN` or `AppConfig.rateLimits`. Responses carry
  `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; `429` adds `Retry-After`. Anonymous clients are keyed by a
  truncated SHA-256 of the address (raw addresses never reach the limiter store or logs). `RateLimiter` is an
  interface; the default is in-memory (per process/isolate). For global limits on Workers plug a Durable Object or the
  Rate Limiting binding into `createApp({ limiter })`.
- **Client address:** behind a proxy set `TRUST_PROXY=true` to use `cf-connecting-ip` / `x-real-ip` /
  `x-forwarded-for`; otherwise the socket address is used (Node) or all clients share one bucket (Workers entry sets
  this automatically because Cloudflare strips spoofed copies).
- **Browsers:** CORS headers only for `ALLOWED_ORIGINS`. Responses carry `nosniff`, `no-referrer`, a deny-all CSP and
  HSTS. Bodies are capped at 64 KiB (413); requests time out after 10 s (504).
- **Privacy:** coordinates are used for the lookup and not stored. Logs are JSON lines with route template, status,
  latency, provider, tool, tier and `trace_id` (also returned as `x-request-id`). Query strings, bodies, tool arguments,
  addresses and keys are never logged; a redaction layer scrubs coordinate-looking values even if a caller slips one
  in, and a test greps captured logs for the coordinates it sent.
- Upstream URLs are configuration only; no endpoint takes a URL, and errors never include upstream URLs or stack traces.

## Running locally

No pnpm needed beyond the initial install (`pnpm install --frozen-lockfile` once; node >= 22):

```bash
npx tsx apps/server/src/node.ts                    # PGlite at ./.data/pglite, ingests the live LMT feed, polls GTFS-RT
curl localhost:8787/healthz
curl 'localhost:8787/v1/stops/nearby?latitude=6.8421&longitude=79.9712'
```

| Variable | Default | |
|---|---|---|
| `PORT`, `HOST` | `8787`, `127.0.0.1` | listen address (`HOST=0.0.0.0` in containers) |
| `DATABASE_URL` | unset | Neon/Postgres URL; unset = in-process PGlite |
| `PGLITE_DIR` | `./.data/pglite` | data dir, or `memory` |
| `SKIP_INGEST` | unset | `1` = do not fetch the static GTFS at start (offline); an offline start otherwise logs and continues |
| `ALLOW_ANONYMOUS` | `true` | |
| `API_KEYS` | none | see above |
| `ALLOWED_ORIGINS` | none | comma separated exact origins |
| `TRUST_PROXY` | `false` | |
| `RATE_LIMIT_ANON_PER_MIN`, `RATE_LIMIT_KEY_PER_MIN` | `30`, `120` | |

The Node entry runs migrations, seeds the provider, starts listening, then (in the background) ingests the static feed
hourly and polls GTFS-RT (every 15 s, relaxed to 60 s when nobody has queried for 10 minutes; the first query after an
idle period triggers an immediate poll). Stop with Ctrl-C. Tests: `npx vitest run apps/server`. Live feed check:
`npx tsx apps/server/scripts/live-check.ts`.

## Deploying to Cloudflare

`apps/server/wrangler.toml` + `src/worker.ts`: `fetch` (REST + MCP, Neon connection per request), `scheduled` (hourly
`runStaticIngest`), and the `RealtimeHubDO` Durable Object (one per provider; `alarm()` polls, persists state to DO
storage, re-arms; `GET /snapshot` is its only query API). From `apps/server`:

```bash
DATABASE_URL=postgres://... npx tsx scripts/migrate.ts   # schema + provider rows (the Worker never migrates)
npx wrangler secret put DATABASE_URL
npx wrangler secret put API_KEYS                         # optional
npx wrangler deploy --dry-run --outdir dist --env=""     # bundle check without an account
npx wrangler deploy
```
Optional `ARCHIVE` R2 binding (commented in `wrangler.toml`) stores GTFS zips and 1-in-240 raw GTFS-RT payloads.
This has been bundled and exercised locally in `wrangler dev` (workerd) for the routes that do not need a database;
it has not been deployed, and Durable Object alarms, Neon-from-Workers and static ingest CPU limits are unverified.
