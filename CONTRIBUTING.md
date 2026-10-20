# Contributing

Start with the [README](README.md), [roadmap](docs/roadmap.md) and [original requirements](requirement.md). Keep pull requests focused and target `main`.

Use Node.js 22.18+ or 24:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Add a focused regression test for new behavior. Use invented data or fixtures with recorded reuse permission. Never commit private telemetry, credentials, passenger records or exact user coordinates. Do not scrape authenticated apps or infer redistribution rights from a public tracker.

Keep synthetic, scheduled, provider-live, derived-live, stale and unavailable states distinct. Preserve source IDs, provenance and timestamps. Invalid candidate feeds must not replace active data. Keep the `--demo` gate until a reviewed adapter and source-access record exist.

Public API or coverage changes must update the README and protocol tests. Real adapters need ownership, permission, attribution, retention and verification evidence in [DATA_SOURCES.md](DATA_SOURCES.md). Follow [SECURITY.md](SECURITY.md) for vulnerability reports.
