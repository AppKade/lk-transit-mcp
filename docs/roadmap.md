# Implementation roadmap

The research describes a larger platform. This table tracks repository evidence.

| Milestone | Status | Acceptance evidence |
|---|---|---|
| Synthetic core | Implemented | Snapshot validation, canonical IDs, distance, bounded queries and invalid activation rollback |
| Local MCP demo | Implemented | Five read-only tools, coverage resource, explicit opt-in and two stdio protocol journeys |
| Source authorization | Pending external evidence | Ownership, reuse/redistribution basis, attribution and retention records |
| GTFS Schedule adapter | Not implemented | Bounded ZIP/CSV; calendars, exceptions, timezone/service days; independent feed validation |
| GTFS-Realtime adapter | Not implemented | Authorized sources, observation age, orphan quarantine, last known-good fallback |
| Real query service | Not implemented | Provider arrivals, vehicles, alerts and health with provenance |
| Routing and ETA | Not implemented | Timetable baseline, transfer constraints and measured prediction quality |
| Remote pilot | Blocked | Source rights, security/privacy review, seven-day ingestion evidence, measured targets |

`freshness()` is tested groundwork, not evidence of actual feed freshness. In-memory snapshots are not a persistent archive. Demo timetable instants do not implement GTFS service calendars. No tool fabricates live vehicles or predictions.

Record provider evidence in [DATA_SOURCES.md](../DATA_SOURCES.md). Additional private-provider adapters require an authorized sample or sandbox. Public npm publishing remains disabled.
