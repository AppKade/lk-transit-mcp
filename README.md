# lk-transit-mcp

Live Sri Lanka bus transit data for AI agents, served over the Model Context Protocol (MCP) and a REST API.
First provider: Lanka Metro Transit (LMT), using its GTFS and GTFS-Realtime feeds.

> **Data authority:** the LMT feeds are community-hosted (`api.transit.seyone.dev`), CC-BY-4.0 per the registry, and
> **not yet confirmed by LMT**. Every response says so in `source.provider_authority`. Do not run a public production
> service until that is resolved (see `docs/development-plan.md`, gate G0).

## What it does

Eight read-only MCP tools (also `/v1/*` REST): `find_stops_nearby`, `get_arrivals`, `get_vehicle_positions`,
`search_routes`, `get_route`, `plan_trip`, `get_service_alerts`, `get_feed_status`.
Every answer carries provider, source, timestamp, licence and freshness. Arrivals are labelled `scheduled`,
`provider_live` or `stale`; live data older than 90 s is never presented as live.

## Run locally

```sh
pnpm install
npx tsx apps/server/src/node.ts      # serves on 127.0.0.1:8787, ingests the live LMT feeds into ./.data/pglite
npx vitest run                       # full suite (offline, uses recorded fixtures)
npx tsc --noEmit -p tsconfig.json
```

MCP endpoint: `POST /mcp` (stateless Streamable HTTP). See `docs/api.md` for env vars, auth, rate limits and client setup.

## Layout

| Path | Purpose |
|---|---|
| `packages/core` | ids, time (Asia/Colombo), freshness, envelope, tool schemas, provider config |
| `packages/db` | Postgres schema + migrations; PGlite (local/tests) and Neon (production) adapters |
| `packages/gtfs` | GTFS zip parser/validator, GTFS-RT decoder/normaliser (Workers-safe) |
| `packages/ingest` | atomic static ingest with rollback; `RealtimeHub` poller and route resolution |
| `packages/query` | stops, arrivals, vehicles, routes, alerts, status, trip planner |
| `apps/server` | Hono app: REST, MCP, auth, rate limiting, logging; Node and Cloudflare Worker entries |
| `fixtures/lmt` | recorded real feeds used by tests |
| `test/e2e` | static ingest -> realtime hub -> queries on recorded fixtures |

## Docs

`requirement.md` (feasibility study), `docs/development-plan.md` (plan and implementation status), `docs/api.md`.
