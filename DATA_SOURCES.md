# Data sources and permission status

No real provider is enabled. Network polling and provider-data redistribution are not implemented.

| Source | Repository evidence | Enabled |
|---|---|---|
| AppKade synthetic fixture | Invented in `src/demo.ts`; Apache-2.0; no operator data | Demo only |
| LMT / community GTFS and GTFS-RT | Research candidate; current ownership, terms and permission not independently recorded | No |
| SLTB / eSeat | No authorized sample or API agreement recorded | No |
| CPTSA / vendor telemetry | No authorized sample or API agreement recorded | No |
| NTC / private operators | No authorized feed or redistribution record | No |

URLs in `requirement.md` are research leads. Accessibility and rights have not been independently revalidated in this implementation. A registry label or public rider application does not establish the authorization record required by the project plan.

Before enabling a source, record owner/operator, exact URL, provider namespace, format, retrieval/observation timestamps, verification date, reuse basis and permission evidence, attribution, retention, redistribution status and reviewer. Keep credentials outside git. Never invent verification dates or approval.

The code license does not cover operator logos, schedules, tracking data or archives. Public deployment stays gated by the requirements' source-access and production-review checkpoints.
