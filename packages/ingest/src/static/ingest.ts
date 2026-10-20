import { systemClock } from '@lkt/core';
import type { Clock, Db, ProviderConfig } from '@lkt/core';
import { GtfsParseError, parseGtfsZip, prepareGtfs, reportForParseError } from '@lkt/gtfs';
import type { ParsedGtfs, ValidationOptions, ValidationReport } from '@lkt/gtfs';
import { activateVersion, getActiveFeed } from './feeds.js';
import { fetchBytes, sha256Hex } from './fetch.js';
import { loadFeed } from './load.js';

export interface StaticIngestDeps {
  db: Db;
  provider: ProviderConfig;
  clock?: Clock;
  fetchImpl?: typeof fetch;
  /** Raw zip archive (R2 in production). Failure to archive never blocks activation. */
  archive?: { put(key: string, bytes: Uint8Array): Promise<void> };
}

export interface StaticIngestOptions {
  /** Re-ingest even if the checksum equals the active version's (e.g. after a validator/parser fix). */
  force?: boolean;
  /** Passed to validateGtfs (thresholds, bands). `clock` and `previousCounts` are filled in by the ingester. */
  validation?: Omit<ValidationOptions, 'clock' | 'previousCounts'>;
  fetchTimeoutMs?: number;
  maxDownloadBytes?: number;
}

export type StaticIngestResult =
  | { status: 'unchanged'; feed_version_id: number; label: string; checksum: string }
  | {
      status: 'activated';
      feed_version_id: number;
      previous_feed_version_id: number | null;
      label: string;
      checksum: string;
      report: ValidationReport;
      archive_key: string | null;
      archive_error?: string;
    }
  | {
      status: 'rejected';
      feed_version_id: number;
      label: string;
      checksum: string;
      report: ValidationReport;
      /** True when this exact payload had already been rejected earlier; nothing new was recorded. */
      repeat?: boolean;
    }
  | { status: 'failed'; stage: 'config' | 'fetch' | 'parse' | 'load' | 'activate'; error: string; checksum?: string };

/** Staged versions older than this are assumed to be left over from a crashed run and are deleted. */
export const STALE_STAGED_MS = 30 * 60_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export async function ensureProvider(db: Db, provider: ProviderConfig): Promise<void> {
  await db.query(
    `INSERT INTO providers (id, name, timezone) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, timezone = EXCLUDED.timezone`,
    [provider.id, provider.name, provider.timezone],
  );
}

/** Deletes staged versions (and, by cascade, their rows) that no live run can still own. */
export async function cleanupStaged(db: Db, providerId: string, olderThanMs: number): Promise<number> {
  const r = await db.query(
    `DELETE FROM feed_versions WHERE provider_id = $1 AND status = 'staged' AND fetched_at < $2`,
    [providerId, new Date(olderThanMs).toISOString()],
  );
  return r.rowCount;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** feed_versions.checksum is unique per provider among non-rejected rows; forced re-ingests get a `+suffix`. */
const baseChecksum = (stored: string) => stored.split('+', 1)[0]!;

/**
 * Fetch -> checksum -> (archive) -> parse -> validate -> stage -> bulk load -> atomic activation.
 * Whatever happens, the previously active version is left untouched until the final one-transaction swap.
 */
export async function runStaticIngest(deps: StaticIngestDeps, opts: StaticIngestOptions = {}): Promise<StaticIngestResult> {
  const { db, provider } = deps;
  const clock = deps.clock ?? systemClock;
  const source = provider.sources.find((s) => s.kind === 'gtfs_static');
  if (!source) return { status: 'failed', stage: 'config', error: `provider ${provider.id} has no gtfs_static source` };

  await ensureProvider(db, provider);
  // Housekeeping must never stop a good feed from loading.
  await cleanupStaged(db, provider.id, clock.now() - STALE_STAGED_MS).catch(() => 0);

  let bytes: Uint8Array;
  try {
    bytes = await fetchBytes(deps.fetchImpl ?? fetch, source.url, {
      timeoutMs: opts.fetchTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: opts.maxDownloadBytes ?? DEFAULT_MAX_BYTES,
    });
  } catch (e) {
    return { status: 'failed', stage: 'fetch', error: errText(e) };
  }
  const checksum = await sha256Hex(bytes);

  const active = await getActiveFeed(db, provider.id);
  if (active && baseChecksum(active.checksum) === checksum && !opts.force) {
    return { status: 'unchanged', feed_version_id: active.id, label: active.label, checksum };
  }
  if (!opts.force) {
    const prior = await db.query<{ id: number | string; label: string; validation: ValidationReport | string }>(
      `SELECT id, label, validation FROM feed_versions
        WHERE provider_id = $1 AND status = 'rejected' AND checksum = $2 ORDER BY id DESC LIMIT 1`,
      [provider.id, checksum],
    );
    const p = prior.rows[0];
    if (p) {
      const report = typeof p.validation === 'string' ? (JSON.parse(p.validation) as ValidationReport) : p.validation;
      return { status: 'rejected', feed_version_id: Number(p.id), label: p.label, checksum, report, repeat: true };
    }
  }

  const nowMs = clock.now();
  const nowIso = new Date(nowMs).toISOString();
  const label = `${nowIso.slice(0, 16)}Z-${checksum.slice(0, 6)}`;
  const archiveKey = `${provider.id}/gtfs/${label}.zip`;
  let archivedAs: string | null = null;
  let archiveError: string | undefined;
  if (deps.archive) {
    try {
      await deps.archive.put(archiveKey, bytes);
      archivedAs = archiveKey;
    } catch (e) {
      archiveError = errText(e);
    }
  }

  // Parse + validate. An unreadable archive is a rejection, not a crash.
  const vopts: ValidationOptions = { ...opts.validation, clock, previousCounts: active?.counts ?? null };
  let report: ValidationReport;
  let feed: ParsedGtfs | null;
  try {
    ({ report, feed } = tryPrepare(bytes, vopts));
  } catch (e) {
    return { status: 'failed', stage: 'parse', error: errText(e), checksum };
  }

  const insertVersion = async (status: 'staged' | 'rejected'): Promise<number> => {
    // Unique (provider, checksum) among non-rejected rows: a forced/reverted re-ingest of known bytes needs a suffix.
    let stored = checksum;
    if (status === 'staged') {
      const dup = await db.query(
        `SELECT 1 FROM feed_versions WHERE provider_id = $1 AND status <> 'rejected' AND checksum = $2`,
        [provider.id, checksum],
      );
      if (dup.rows.length) stored = `${checksum}+${crypto.randomUUID().slice(0, 8)}`;
    }
    const r = await db.query<{ id: number | string }>(
      `INSERT INTO feed_versions (provider_id, status, checksum, label, source_key, fetched_at, calendar_start, calendar_end, counts, validation, archive_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11) RETURNING id`,
      [
        provider.id,
        status,
        stored,
        label,
        source.key,
        nowIso,
        report.calendar_start,
        report.calendar_end,
        JSON.stringify(report.counts),
        JSON.stringify(report),
        archivedAs,
      ],
    );
    return Number(r.rows[0]!.id);
  };

  if (!report.acceptable || !feed) {
    try {
      const id = await insertVersion('rejected');
      return { status: 'rejected', feed_version_id: id, label, checksum, report };
    } catch (e) {
      return { status: 'failed', stage: 'load', error: errText(e), checksum };
    }
  }

  let versionId: number | null = null;
  try {
    versionId = await insertVersion('staged');
    await loadFeed(db, versionId, feed);
  } catch (e) {
    await discardStaged(db, versionId);
    return { status: 'failed', stage: 'load', error: errText(e), checksum };
  }
  try {
    const previous = await activateVersion(db, provider.id, versionId, 'staged', nowIso);
    return {
      status: 'activated',
      feed_version_id: versionId,
      previous_feed_version_id: previous,
      label,
      checksum,
      report,
      archive_key: archivedAs,
      ...(archiveError ? { archive_error: archiveError } : {}),
    };
  } catch (e) {
    await discardStaged(db, versionId);
    return { status: 'failed', stage: 'activate', error: errText(e), checksum };
  }
}

function tryPrepare(bytes: Uint8Array, vopts: ValidationOptions): { report: ValidationReport; feed: ParsedGtfs | null } {
  try {
    const prepared = prepareGtfs(parseGtfsZip(bytes), vopts);
    return { report: prepared.report, feed: prepared.feed };
  } catch (e) {
    if (e instanceof GtfsParseError) return { report: reportForParseError(e, vopts), feed: null };
    throw e;
  }
}

/** Best effort; anything left behind is invisible to queries and removed by the next run's cleanupStaged. */
async function discardStaged(db: Db, versionId: number | null): Promise<void> {
  if (versionId === null) return;
  try {
    await db.query(`DELETE FROM feed_versions WHERE id = $1 AND status = 'staged'`, [versionId]);
  } catch {
    /* swept later */
  }
}
