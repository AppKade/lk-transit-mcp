import type { Db } from '@lkt/core';
import type { FeedCounts } from '@lkt/gtfs';

export interface FeedVersionInfo {
  id: number;
  provider_id: string;
  status: 'staged' | 'active' | 'rejected' | 'retired';
  is_active: boolean;
  label: string;
  checksum: string;
  source_key: string;
  fetched_at: string;
  activated_at: string | null;
  calendar_start: string | null;
  calendar_end: string | null;
  counts: Partial<FeedCounts>;
  archive_key: string | null;
  errors: number;
  warnings: number;
  needs_review: boolean;
}

interface FeedRow {
  id: number | string;
  provider_id: string;
  status: FeedVersionInfo['status'];
  active_id: number | string | null;
  label: string;
  checksum: string;
  source_key: string;
  fetched_at: string;
  activated_at: string | null;
  calendar_start: string | null;
  calendar_end: string | null;
  counts: Partial<FeedCounts> | string;
  archive_key: string | null;
  errors: number | string | null;
  warnings: number | string | null;
  needs_review: boolean | null;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;

/** Newest first. Dates come back as ISO strings regardless of driver. */
export async function listFeeds(db: Db, providerId: string): Promise<FeedVersionInfo[]> {
  const { rows } = await db.query<FeedRow>(
    `SELECT fv.id, fv.provider_id, fv.status, p.active_feed_version_id AS active_id, fv.label, fv.checksum, fv.source_key,
            to_char(fv.fetched_at AT TIME ZONE 'UTC', ${ISO}) AS fetched_at,
            to_char(fv.activated_at AT TIME ZONE 'UTC', ${ISO}) AS activated_at,
            fv.calendar_start::text AS calendar_start, fv.calendar_end::text AS calendar_end,
            fv.counts, fv.archive_key,
            (fv.validation->>'errors')::int AS errors, (fv.validation->>'warnings')::int AS warnings,
            (fv.validation->>'needs_review')::boolean AS needs_review
       FROM feed_versions fv JOIN providers p ON p.id = fv.provider_id
      WHERE fv.provider_id = $1
      ORDER BY fv.id DESC`,
    [providerId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    provider_id: r.provider_id,
    status: r.status,
    is_active: r.active_id !== null && Number(r.active_id) === Number(r.id),
    label: r.label,
    checksum: r.checksum,
    source_key: r.source_key,
    fetched_at: r.fetched_at,
    activated_at: r.activated_at,
    calendar_start: r.calendar_start,
    calendar_end: r.calendar_end,
    counts: typeof r.counts === 'string' ? (JSON.parse(r.counts) as Partial<FeedCounts>) : r.counts,
    archive_key: r.archive_key,
    errors: Number(r.errors ?? 0),
    warnings: Number(r.warnings ?? 0),
    needs_review: r.needs_review === true,
  }));
}

export interface ActiveFeed {
  id: number;
  label: string;
  checksum: string;
  counts: Partial<FeedCounts>;
}

export async function getActiveFeed(db: Db, providerId: string): Promise<ActiveFeed | null> {
  const { rows } = await db.query<{ id: number | string; label: string; checksum: string; counts: Partial<FeedCounts> | string }>(
    `SELECT fv.id, fv.label, fv.checksum, fv.counts
       FROM providers p JOIN feed_versions fv ON fv.id = p.active_feed_version_id
      WHERE p.id = $1`,
    [providerId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    label: r.label,
    checksum: r.checksum,
    counts: typeof r.counts === 'string' ? (JSON.parse(r.counts) as Partial<FeedCounts>) : r.counts,
  };
}

/**
 * Atomically makes `versionId` the provider's active feed: the previous active becomes 'retired', the target
 * 'active', and providers.active_feed_version_id moves, all in one transaction. `from` is the expected status of
 * the target ('staged' for a fresh ingest, 'retired' for rollback); anything else aborts.
 */
export async function activateVersion(
  db: Db,
  providerId: string,
  versionId: number,
  from: 'staged' | 'retired',
  nowIso: string,
): Promise<number | null> {
  return db.transaction(async (tx) => {
    const cur = await tx.query<{ active: number | string | null }>(
      'SELECT active_feed_version_id AS active FROM providers WHERE id = $1 FOR UPDATE',
      [providerId],
    );
    if (cur.rows.length === 0) throw new Error(`unknown provider ${providerId}`);
    const previous = cur.rows[0]!.active === null ? null : Number(cur.rows[0]!.active);
    const target = await tx.query(
      'SELECT 1 FROM feed_versions WHERE id = $1 AND provider_id = $2 AND status = $3 FOR UPDATE',
      [versionId, providerId, from],
    );
    if (target.rows.length === 0) throw new Error(`feed version ${versionId} is not ${from}`);
    await tx.query(`UPDATE feed_versions SET status = 'retired' WHERE provider_id = $1 AND status = 'active'`, [providerId]);
    await tx.query(`UPDATE feed_versions SET status = 'active', activated_at = $2 WHERE id = $1`, [versionId, nowIso]);
    await tx.query('UPDATE providers SET active_feed_version_id = $2 WHERE id = $1', [providerId, versionId]);
    return previous;
  });
}

export type RollbackResult =
  | { status: 'rolled_back'; from_feed_version_id: number | null; to_feed_version_id: number; label: string }
  | { status: 'nothing_to_roll_back_to' };

/**
 * Re-activates the most recently active retired version (or `toFeedVersionId`), retiring the current one.
 * Calling it twice in a row toggles between the two newest versions; pass an explicit target to go further back.
 */
export async function rollbackFeed(
  db: Db,
  providerId: string,
  opts: { toFeedVersionId?: number; now?: number } = {},
): Promise<RollbackResult> {
  const { rows } = await db.query<{ id: number | string; label: string }>(
    `SELECT id, label FROM feed_versions
      WHERE provider_id = $1 AND status = 'retired' AND ($2::bigint IS NULL OR id = $2::bigint)
      ORDER BY activated_at DESC NULLS LAST, id DESC LIMIT 1`,
    [providerId, opts.toFeedVersionId ?? null],
  );
  const target = rows[0];
  if (!target) return { status: 'nothing_to_roll_back_to' };
  const from = await activateVersion(db, providerId, Number(target.id), 'retired', new Date(opts.now ?? Date.now()).toISOString());
  return { status: 'rolled_back', from_feed_version_id: from, to_feed_version_id: Number(target.id), label: target.label };
}

/** Deletes (with all their rows) retired versions beyond the `keep` most recently active. Returns the deleted ids. */
export async function pruneRetired(db: Db, providerId: string, keep: number): Promise<number[]> {
  const { rows } = await db.query<{ id: number | string }>(
    `DELETE FROM feed_versions WHERE id IN (
       SELECT id FROM feed_versions
        WHERE provider_id = $1 AND status = 'retired'
        ORDER BY activated_at DESC NULLS LAST, id DESC
        OFFSET $2
     ) RETURNING id`,
    [providerId, Math.max(0, Math.floor(keep))],
  );
  return rows.map((r) => Number(r.id)).sort((a, b) => a - b);
}
