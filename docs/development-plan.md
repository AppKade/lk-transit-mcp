# lk-transit-mcp: End-to-End Development Plan (LMT-first MVP)

Derived from `requirement.md`. This plan covers only the core: a provider-neutral transit data platform for Sri Lanka,
with Lanka Metro Transit (LMT) as the first provider and an MCP server as the interface for AI clients.
SLTB, CPTSA, NTC and private operators are out of scope and appear only as extension points.

## 1. Goal and scope

**Goal:** an AI agent can answer "where is the next CM01 near Makumbura?", "what arrives at this stop in 20 minutes?",
"is this live or timetable?" using LMT data, and every answer says where it came from and how fresh it is.

### In scope (MVP)

| # | Capability | Priority |
|---|---|---|
| 1 | Static GTFS ingestion with validation and atomic activation (last known-good survives bad feeds) | P0 |
| 2 | GTFS-RT ingestion: VehiclePositions, TripUpdates, Alerts | P0 |
| 3 | Query core: nearby stops, routes, route detail, arrivals, vehicles, alerts, feed status | P0 |
| 4 | MCP server exposing those queries as tools (plus a few read-only resources) | P0 |
| 5 | Provenance + freshness envelope on every response, with stale-data protection | P0 |
| 6 | Auth/rate limiting, observability, privacy-safe logging | P0 |
| 7 | `plan_trip`: direct plus one-transfer journeys on the schedule, with live delay overlay | P1 |
| 8 | Derived ETA from GPS when upstream TripUpdates are missing, labelled `derived_live` | P1 |

### Out of scope

Payments, ticketing, accounts, driver data, user location history, SLTB/CPTSA/NTC adapters, Sinhala/Tamil alias search,
occupancy/accessibility, historical analytics, ML ETA. The schema and adapter interface must not block them.

## 2. Key decisions

| Decision | Choice | Why |
|---|---|---|
| Language | TypeScript (strict), pnpm monorepo | Official MCP SDK is TS; one language across ingest, API and MCP |
| Runtime | Cloudflare Workers (+ Durable Objects) | Cheap pilot, global edge, matches the requirement's Option A; keep core logic runtime-agnostic so it can move to containers |
| Database | Neon Postgres + PostGIS | Spatial queries, transactional feed activation, scale-to-zero |
| Realtime state | One Durable Object per provider (`RealtimeHub`) | Polls upstream every 15 s via alarms (Cron Triggers are 1 min minimum), holds latest state in memory, serialises reads, coalesces upstream fetches |
| Raw snapshots | R2 (static GTFS zips, sampled RT payloads) | Cheap archive, supports replay and the G1 soak analysis |
| Static ingest trigger | Cron Trigger (hourly check, conditional GET + checksum) | Feed changes rarely; atomic swap on change |
| Protobuf | Generated static decoder (ts-proto or `@bufbuild/protobuf`) from the official `gtfs-realtime.proto` | Avoids `protobufjs` runtime codegen (eval) on Workers; verified in spike S1 |
| MCP transport | Streamable HTTP, single POST endpoint, stateless | Matches the requirement's target spec; verified in spike S2 |
| API | Typed internal service layer plus thin REST (`/v1/...`) | MCP and any future web app share one core; the REST layer is also the contract-test surface |
| IDs | `provider:type:id`, e.g. `lmt:stop:123`; source IDs stored unchanged | Per requirement; supports later crosswalks |
| Validation | Own rule set in code plus MobilityData canonical validator in CI | Cheap runtime gate, authoritative offline check |
| Licence | Apache-2.0 code, CC-BY-4.0 docs, provider data governed by its own licence | Per requirement |

Assumptions to confirm before M1 are listed in section 12.

## 3. Architecture

```
          Cron (hourly)                      Alarm (15 s)
               |                                  |
        +------v------+                    +------v-------+
 LMT    | StaticIngest|   LMT GTFS-RT      | RealtimeHub  |  (Durable Object, per provider)
 GTFS --> fetch, hash, |<-- 3 feeds ------->| poll, decode,|
 zip    | validate,   |                    | validate,    |
        | stage, swap |                    | quarantine,  |
        +------+------+                    | in-mem state |
               |                           +------+-------+
         +-----v------+  raw zips/payloads        |
         | Neon PG +  |<--------- R2 -------------+
         | PostGIS    |                           |
         +-----+------+                           |
               |        +-------------------------v-----+
               +------->|  Query core (TS library)       |
                        |  stops, routes, arrivals,      |
                        |  vehicles, alerts, planner,    |
                        |  provenance + freshness        |
                        +----------+---------+-----------+
                                   |         |
                            REST /v1/*     MCP /mcp (Streamable HTTP)
                                   |         |
                              web/ops      AI hosts
```

Rules that hold the design together:

1. Upstream URLs are configuration, never tool input (no SSRF).
2. Static queries read from the **active feed version** only; realtime entities are joined to that version and
   anything that fails to resolve is quarantined and counted.
3. The query core never returns a realtime value without `observed_at`, `age_seconds`, `freshness` and `source`.
4. Adapters implement one interface (`ProviderAdapter`) so a second provider is an addition, not a refactor.

## 4. Functional design

### 4.1 Response envelope (all tools and REST endpoints)

```json
{
  "provider": "lmt",
  "as_of": "2026-10-20T10:15:12+05:30",
  "freshness": { "status": "fresh|stale|unavailable", "age_seconds": 12, "threshold_seconds": 90 },
  "source": {
    "type": "gtfs_realtime|gtfs_static",
    "url_ref": "lmt.vehicle_positions",
    "feed_version": "2026-10-20T03:00Z-ab12cd",
    "license": "CC-BY-4.0",
    "license_status": "registry_declared_pending_provider_confirmation",
    "attribution": "..."
  },
  "data": []
}
```

`url_ref` is a configured source key, not the raw URL, so clients cannot probe internals. The licence block is not optional.

### 4.2 Arrival semantics

Each arrival carries `prediction_type`:

- `scheduled`: timetable only
- `provider_live`: from an upstream TripUpdate that is fresh
- `derived_live`: computed from current GPS (P1)
- `stale`: last live data exceeded the threshold; scheduled time is shown alongside

### 4.3 MCP tools

Eight tools, all read-only, all with `additionalProperties: false`, bounded limits, and structured output
schemas. Schemas follow `requirement.md` section "MCP implementation"; decisions made here:

| Tool | Behaviour decisions |
|---|---|
| `find_stops_nearby` | radius 50-5000 m (default 800), limit <= 50, ordered by distance, includes routes serving each stop. Coordinates used for the query then discarded |
| `get_arrivals` | `within_minutes` <= 180, merges schedule + live per trip, sorted by best-estimate time, each row has `prediction_type`, `delay_seconds`, `scheduled_time` |
| `get_vehicle_positions` | filter by route / trip / bbox; `max_age_seconds` default 90; stale vehicles excluded unless the caller widens the age, and are then marked stale |
| `search_routes` | case-insensitive match on short name, long name and stop names on the route; limit <= 50 |
| `get_route` | route, directions, ordered stop pattern, first/last trip times, active service today |
| `plan_trip` (P1) | origin/destination as stop or coordinates; direct + at most `max_transfers` (default 1, cap 2); walking assumptions returned explicitly |
| `get_service_alerts` | filter by route/stop; active-period aware; stale threshold 10 min |
| `get_feed_status` | per-source last success, entity age, active feed version, calendar coverage end date, quality counters (orphan ratio, quarantined count) |

Resources (read-only): `transit://providers`, `transit://providers/lmt/status`, `transit://routes/{id}`,
`transit://stops/{id}`, `transit://licenses`.

Tool errors are structured (`unknown_stop`, `invalid_argument`, `provider_unavailable`, `rate_limited`) so the model
can recover instead of guessing.

### 4.4 REST mirror

`GET /v1/providers`, `/v1/stops/nearby`, `/v1/stops/{id}`, `/v1/stops/{id}/arrivals`, `/v1/routes`, `/v1/routes/{id}`,
`/v1/vehicles`, `/v1/alerts`, `POST /v1/journeys/plan`, `GET /v1/health/providers`, `GET /v1/provenance/{provider}`.
Generated from the same Zod schemas as the MCP tools, so there is one definition of each contract.

## 5. Data model

Postgres (PostGIS). Every table that holds feed content carries `feed_version_id`; queries filter on the active version.

| Group | Tables |
|---|---|
| Provider | `providers`, `data_sources`, `source_licenses`, `feed_versions` (status: `staged|active|rejected|retired`, checksum, validation report JSON) |
| Network | `stops` (geography point + GiST index), `routes`, `route_patterns`, `shapes` |
| Timetable | `trips`, `stop_times`, `service_calendars`, `calendar_exceptions` |
| Quality | `validation_runs`, `feed_incidents` |

Activation: load into rows tagged with a new `feed_version_id`, validate, then flip `feed_versions.status` and the
`providers.active_feed_version_id` pointer in one transaction. Rejection leaves the previous version untouched.
Retire versions after N days; keep zips in R2.

Realtime state lives in the Durable Object (latest vehicles, trip updates, alerts, per-source headers, quarantine
counters), persisted to DO storage so a restart does not blank the map. Observation history
(`vehicle_observations`) is a deferred table, only added if the G1 soak or ETA work needs it.

## 6. Work breakdown

Team assumed: 2 engineers, with part-time QA/data support and a product/stakeholder lead. Estimates are person-days.

### M0: Foundations and spikes (week 1, ~6 days)

- Monorepo, TS strict, lint/format, Vitest, CI skeleton, Wrangler config for `dev` and `prod`
- **S1** protobuf decoding of the three real LMT feeds in a Worker; record fixtures
- **S2** MCP SDK on Workers with Streamable HTTP; check against the current spec text (the spec version in
  `requirement.md` is taken as given and must be verified here, including the `MCP-Protocol-Version` header and
  Origin validation)
- **S3** Neon + PostGIS from Workers (driver choice, connection handling, latency)
- **S4** unzip + CSV parse of the LMT GTFS within Worker CPU/memory limits
- Start G0: contact LMT and the `seyone.dev` maintainer (runs in parallel with all engineering)

Exit: all four spikes have a written result; any failure triggers a stack decision before M1.

### M1: Canonical model and static ingestion (weeks 2-3, ~12 days)

- `ProviderAdapter` interface and `lmt` adapter config (sources, thresholds, licence block)
- Migrations for section 5; seed `providers` / `source_licenses` from config
- Static pipeline: conditional fetch, checksum, store zip in R2, parse, validate, stage, activate, retire
- Validation rules from the requirement (required files/fields, FKs, duplicate IDs, coordinate validity and Sri Lanka
  bounding box, monotonic stop sequences, internally consistent times, usable future service, count-change bands)
- Run the MobilityData validator in CI against the fixture and the nightly live feed
- Admin CLI: `ingest:static --force`, `feed:list`, `feed:rollback`

Exit: a corrupt feed is rejected and the previous version keeps serving; a good feed activates atomically;
validation report stored per version.

### M2: Realtime ingestion (weeks 3-4, ~12 days)

- `RealtimeHub` DO: alarm loop (15 s, jittered), per-feed conditional fetch, timeouts, exponential backoff, circuit state
- Decode and validate VehiclePositions, TripUpdates, Alerts (checks listed in `requirement.md`); bad entities are
  quarantined and counted, never crash the loop
- Join to active feed version (trip/route/stop resolution); orphan ratio metric
- Freshness computation from header and entity timestamps (thresholds: 90 s vehicles/trips, 10 min alerts)
- Sampled raw payloads to R2 (1 in N) for replay and debugging
- Replay tool: feed a recorded sequence through the hub in tests

Exit: 7-day soak **starts** here (this is gate G1) and runs through M3-M5. Tracked: poll success >= 99%, no unexplained
timestamp freezes, orphan ratio < 0.5%.

### M3: Query core and REST (weeks 4-5, ~12 days)

- Library functions for every capability in 4.3, returning the envelope
- Nearby stops via PostGIS KNN/`ST_DWithin`; route search; route detail with pattern
- Arrivals: scheduled stop_times for today's active services, merged with live TripUpdates, midnight-rollover and
  after-midnight (>24:00) GTFS times handled, Asia/Colombo timezone handling
- Vehicles and alerts with freshness handling
- Caching per the requirement table (stops/routes 5-30 min, nearby 1-5 min by spatial cell, arrivals 10-20 s)
- REST routes + OpenAPI generated from the shared Zod schemas

Exit: golden E2E fixture test passes (synthetic GTFS + RT -> arrivals with correct `prediction_type`); p95 targets met
under synthetic load (cached < 750 ms, uncached < 2 s).

### M4: MCP server (weeks 5-6, ~10 days)

- Tool and resource registration from the shared schemas; structured outputs and structured errors
- Streamable HTTP endpoint, protocol-version header check, Origin allowlist
- Tool descriptions written for model use (when to call, what freshness means, how to read `prediction_type`)
- Contract tests per tool: valid, boundary coordinates, unknown IDs, oversized radius, malformed args, stale and
  unavailable upstream
- Test with MCP Inspector and at least two real clients (e.g. Claude, one other host)

Exit: all tools pass contract tests; a recorded demo answers the three headline questions from `requirement.md`.

### M5: Security, observability, hardening (weeks 6-7, ~10 days)

- Auth: anonymous read with strict per-IP/per-key rate limits plus API keys for higher quotas; OAuth only if a
  privileged tool ever appears (none in MVP)
- Fixed outbound allowlist; secrets only in Wrangler secrets; dependency audit and SBOM in CI
- Structured JSON logs with `trace_id`, provider, source, operation, latency; **no exact coordinates, tokens or raw
  payloads** (lint rule plus a test that greps captured logs)
- Metrics listed in the requirement (poll success, entity age, orphan ratio, tool latency, cache hit ratio, ...),
  dashboards, and the alert table (entity age > 90 s for 5 min warning, > 5 min critical, 3 failed polls, validation
  failure, 5xx > 2%)
- Threat model and incident runbook (stale feed, bad static release, upstream gone, key leak)

Exit: no open P0/P1 defects; alerts fire in a staged failure drill.

### M6: Journey planning and derived ETA (weeks 7-8, ~14 days, P1, cut-able)

- `plan_trip`: load the (small) LMT network into memory per feed version; earliest-arrival search over direct trips
  and transfers at shared or nearby (<= 250 m) stops; walking and transfer assumptions returned explicitly;
  live delays overlaid when fresh
- Derived ETA: when a trip has a fresh GPS position but no TripUpdate, project along the shape using recent speed and
  label `derived_live`; fall back to `scheduled` when GPS is sparse
- Offline evaluation harness for ETA against observed stop passages (geofence + track intersection), comparing
  timetable, delay propagation and distance/speed baselines

Exit (G2): planner returns valid journeys for sampled O/D pairs; derived ETA beats the timetable baseline on the
soak data, or is shipped disabled behind a flag.

### M7: Soak, pilot, docs, release (weeks 8-10, ~8 days)

- Review the 7-day soak against G1; fix anything it found
- Docs: `ARCHITECTURE.md`, `DATA_SOURCES.md`, `DATA_LICENSING.md`, `PROVENANCE.md`, `SECURITY.md`, `THREAT_MODEL.md`,
  `CONTRIBUTING.md`, client setup guide for MCP hosts
- Add `LICENSE` (Apache-2.0) and `NOTICE`
- Pilot with a small set of users; collect failed or confusing queries
- Release notes; the public endpoint stays behind a flag until G0 and G3 are closed

### Effort summary

| Milestone | Days |
|---|---:|
| M0 Foundations and spikes | 6 |
| M1 Static ingestion | 12 |
| M2 Realtime ingestion | 12 |
| M3 Query core and REST | 12 |
| M4 MCP server | 10 |
| M5 Security and observability | 10 |
| M6 Planner and ETA (P1) | 14 |
| M7 Soak, docs, release | 8 |
| **Total** | **84** |
| Contingency (15%) | ~13 |
| **Planning figure** | **~97 person-days, about 9-10 calendar weeks** |

Without M6, the P0 MVP is about 70 days. This is slightly below the requirement document's 92-132 range because
SLTB-shaped generality and the broader ops work are trimmed; rights and legal delays add calendar time, not engineering days.

## 7. Repository layout

```
/packages
  core/         canonical types, ID helpers, Zod schemas (shared by REST and MCP), envelope, freshness
  gtfs/         static parser, validator rules, realtime decoder, generated proto types
  query/        stops, routes, arrivals, vehicles, alerts, planner, ETA
  adapters/lmt/ ProviderAdapter implementation and source config
/apps
  worker/       Worker entry: REST, MCP endpoint, cron handler, RealtimeHub DO
  cli/          admin and replay tooling
/db             migrations, seed
/fixtures       recorded GTFS zip and RT sequences (small, licence-checked)
/infra          Wrangler config, CI workflows
/docs           this plan, architecture, data and licensing docs
```

## 8. Test strategy

| Layer | Approach |
|---|---|
| Unit | Parsers, validators, ID helpers, time handling (>24:00, DST-free but UTC+5:30 offsets), freshness, arrival merge |
| Data quality | MobilityData GTFS validator in CI on fixture and nightly on live feed; RT checks in code |
| Property/fuzz | Malformed protobuf and truncated zips must never crash the loop or activate a feed |
| Integration | Ephemeral Postgres + PostGIS, migrations, activation/rollback, nearby-stop queries |
| Replay | Recorded RT sequences through `RealtimeHub`; assert freshness transitions and quarantine counts |
| Contract | One suite per MCP tool and REST route against shared schemas |
| E2E golden | Synthetic GTFS + RT -> adapter -> store -> REST -> MCP `tools/call`, asserting source, timestamp, freshness, `prediction_type` |
| Load | 100 req/s sustained, 1,000 burst against cached paths; confirm latency targets |
| Soak | 7 days live, against G1 criteria |
| Privacy | Test that captured logs contain no coordinates, tokens or payloads |

## 9. CI/CD and environments

- **Environments:** `dev` (local Wrangler + local Postgres), `staging` (real LMT feeds, separate Neon branch), `prod`
- **CI on every PR:** typecheck, lint, unit, integration (Postgres service container), contract tests, dependency
  audit, GTFS validator on fixtures
- **Nightly:** live-feed validation, E2E smoke, dashboard of drift (route/stop count changes)
- **Deploy:** staging on merge to `main`; prod by tagged release after manual approval; DB migrations run before the
  Worker rollout and are backward compatible for one version
- **Rollback:** Worker version rollback plus `feed:rollback` for data

## 10. Non-functional targets (from the requirement)

Cached p95 < 750 ms, uncached < 2 s, MCP tool p95 < 2.5 s; 99.5% monthly availability; vehicle/trip entity age
p95 < 60 s when upstream is healthy with hard stale at 90 s; orphan RT references < 0.5%; zero corrupt activations;
zero coordinate leakage. Platform availability and provider freshness are tracked as separate SLIs.

## 11. Milestone gates

| Gate | When | Criterion |
|---|---|---|
| G0 Source authorisation | Before public launch | Written LMT confirmation of the `seyone.dev` feeds (or an official replacement) covering caching, derived predictions and redistribution. Prototype and staging proceed without it |
| G1 Feed reliability | End of soak (week ~7) | >= 99% successful polls, no unexplained multi-hour freezes, orphan ratio < 0.5%, no critical static validation errors, stale detection demonstrated |
| G2 Information quality | End of M6 | Planner and ETA beat timetable-only; no ghost or stale-as-live results |
| G3 Production readiness | End of M7 | Licence record, privacy review, SBOM, secrets review, retention policy, incident runbook |

## 12. Risks and open items

| Risk | Impact | Mitigation |
|---|---|---|
| LMT never confirms the community feed's authority | Cannot launch publicly | Run G0 outreach from week 1; keep the source flagged `provider_authority: unconfirmed`; the architecture works with any replacement endpoint |
| `seyone.dev` feed unstable or changes IDs | Orphans, broken answers | Persistent-ID churn alert, last known-good dataset, 7-day soak before launch |
| Workers CPU/memory limits for zip + CSV parse | Static ingest fails | Spike S4; fall back to a chunked or GitHub-Actions-run loader writing to Postgres |
| Protobuf or MCP SDK incompatible with Workers | Re-platform | Spikes S1/S2 in week 1; fallback is the same code in a Node container (core is runtime-agnostic) |
| 15 s alarm polling costs more than expected | Budget | Alarm only polls while queries occurred in the last N minutes, otherwise relaxes to 60 s |
| MCP spec details differ from `requirement.md` | Rework in M4 | Spike S2 verifies against the live spec before building |
| Tiny network (6-7 routes) hides scaling problems | Surprise on expansion | Synthetic national-scale fixture in load tests |
| Pilot cost overrun | Budget | Requirement estimate is $20-115/mo; add usage alerts on Workers/Neon |

### Questions to settle before M1

1. Is Cloudflare Workers + Neon acceptable as the deployment target, or should this run in a container (AWS/other)?
2. Who owns the G0 outreach to LMT and the `seyone.dev` maintainer?
3. Should the public endpoint be anonymous with rate limits, or key-only from day one?
4. Is `plan_trip` (M6) required for the first release, or can it follow?
5. Which MCP hosts must be verified in M4?

## 13. Definition of done (MVP)

- All P0 tools return enveloped, schema-valid responses on live LMT data in staging
- Gates G1 and G3 closed; G0 closed or the public endpoint is explicitly limited to pilot users
- A fresh developer can clone, run `pnpm dev`, ingest the fixture, and call every tool in under 30 minutes
- Documentation set from M7 published, with `DATA_SOURCES.md` recording authority status for the LMT feeds
