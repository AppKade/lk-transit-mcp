/**
 * Nightly smoke check against the real LMT feeds:  npx tsx apps/server/scripts/live-check.ts
 * Fetches the static GTFS zip and the three GTFS-RT feeds from the configured sources, decodes them with the same
 * code the ingesters use, and exits 1 if any feed cannot be fetched or decoded. Staleness is reported as a warning
 * (upstream outages are not our regression). The CI job runs this with continue-on-error.
 */
import { LMT } from '@lkt/core';
import { decodeFeed, parseGtfsZip, validateGtfs } from '@lkt/gtfs';

const TIMEOUT_MS = 30_000;
const STALE_WARN_S = 600;

interface Row {
  source: string;
  ok: boolean;
  detail: string;
  warning?: string;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function check(key: string, kind: string, url: string): Promise<Row> {
  try {
    const bytes = await fetchBytes(url);
    if (kind === 'gtfs_static') {
      const report = validateGtfs(parseGtfsZip(bytes));
      const c = report.counts as unknown as Record<string, number>;
      return {
        source: key,
        ok: report.acceptable,
        detail: `${bytes.length} bytes; errors=${report.errors} warnings=${report.warnings} routes=${c.routes} stops=${c.stops} trips=${c.trips}`,
      };
    }
    const nowMs = Date.now();
    const feed = decodeFeed(bytes, { nowMs });
    if (!feed.ok) return { source: key, ok: false, detail: `${feed.reason}: ${feed.error}` };
    const age = Math.round((nowMs - feed.header.timestamp_ms) / 1000);
    return {
      source: key,
      ok: true,
      detail: `${bytes.length} bytes; ${feed.entities.length} entities; header age ${age}s`,
      ...(age > STALE_WARN_S ? { warning: `header is ${age}s old (> ${STALE_WARN_S}s): upstream may be stalled` } : {}),
    };
  } catch (err) {
    // Message only (no URL): the failure class is what matters in CI logs.
    return { source: key, ok: false, detail: `${err instanceof Error ? err.name : 'Error'}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const rows = await Promise.all(LMT.sources.map((s) => check(s.key, s.kind, s.url)));
for (const r of rows) {
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.source}: ${r.detail}`);
  if (r.warning) console.log(`WARN ${r.source}: ${r.warning}`);
}
const failed = rows.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`${failed.length} of ${rows.length} live checks failed`);
  process.exit(1);
}
console.log(`all ${rows.length} live feeds decoded`);
