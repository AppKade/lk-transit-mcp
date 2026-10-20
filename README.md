# LK Transit MCP

An offline first foundation for querying Sri Lankan transit through MCP. Part of [AppKade Open](https://open.appkade.lk).

[![CI](https://github.com/AppKade/lk-transit-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/AppKade/lk-transit-mcp/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)

## Current status

**Synthetic development prototype. No real operator, live feed, public endpoint or travel service is connected.** All bundled stops, routes and arrivals are invented. Every result includes `mode: synthetic_demo`, `production_ready: false`, provenance and a warning. Do not use these results for travel decisions.

The original [requirements and feasibility research](requirement.md) describes the larger proposed platform. It is a plan, not a list of implemented features. Imported citation markers are research-export references, not independently verified repository evidence. See [the implementation roadmap](docs/roadmap.md).

## Run locally

Requires Node.js **22.18+** or 24. npm publishing is disabled.

```sh
git clone https://github.com/AppKade/lk-transit-mcp.git
cd lk-transit-mcp
npm ci --ignore-scripts
npm run check
npm test
npm start -- --demo
```

The last command waits for MCP messages on stdin. It is not an interactive terminal chat. Startup without `--demo` exits with usage instructions. No network connection or credentials are needed after dependency installation.

Connect an MCP host using an absolute path:

```json
{
  "mcpServers": {
    "lk-transit-demo": {
      "command": "node",
      "args": ["/absolute/path/lk-transit-mcp/src/cli.ts", "--demo"]
    }
  }
}
```

The source runs with Node's TypeScript stripping. This private prototype has no compiled npm package or remote HTTP transport yet.

## Available tools

| Tool | Implemented behavior |
|---|---|
| `find_stops_nearby` | Bounded nearby-stop search, ordered by haversine distance |
| `search_routes` | Search invented route IDs and names |
| `get_route` | Canonical route ID and ordered stop sequence |
| `get_arrivals` | Synthetic scheduled arrivals after an explicit timestamp with timezone offset |
| `get_feed_status` | Prototype coverage, unavailable real-time feeds and missing integrations |

`transit://coverage` exposes coverage as an MCP resource. All tools are read-only. Both legacy initialization and newer discovery are tested over the actual stdio executable.

Example arguments:

```json
{"latitude":6.9271,"longitude":79.8612,"radius_m":1000,"limit":10}
```

```json
{"stop_id":"demo:stop:A","at":"2026-10-21T07:30:00+05:30","limit":10}
```

The fixture timetable exists only on **21 October 2026**. Later queries return no arrivals rather than shifting old schedules to today. Calendars, service-day rollover, GTFS times beyond midnight, live predictions and transfers are not implemented.

## Data foundation

- Strict snapshots, unique IDs and route/stop reference checks.
- Atomic activation: invalid candidates leave the last known-good snapshot intact in memory.
- Provider-scoped IDs preserve original source identifiers, including leading zeros.
- A separate freshness utility uses observation timestamps, marks old observations stale and rejects future or invalid observations. Demo results always remain labeled synthetic.
- Bounded query radius, result count and snapshot collections; no coordinate logging or persistence.

The snapshot schema is an **internal synthetic fixture format**, not a GTFS importer. No provider data is bundled. [Source access and licensing](DATA_SOURCES.md) are prerequisites for a real adapter.

## Remaining work

GTFS ZIP/CSV ingestion and validation, GTFS-Realtime ingestion, calendars/timezones, authorized source records, provider health, real arrivals/vehicles/alerts, journey planning, ETA evaluation, persistent storage and a reviewed remote deployment. Production performance targets in the research have not been measured.

## Contributing and license

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [the roadmap](docs/roadmap.md). Source code and original synthetic fixtures use [Apache-2.0](LICENSE); see [NOTICE](NOTICE). Provider data keeps its own license and is not covered by the code license.
