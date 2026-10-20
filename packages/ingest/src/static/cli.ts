/**
 * Manual verification tool.
 *   npx tsx packages/ingest/src/static/cli.ts <pglite-data-dir> [gtfs.zip] [--force]
 * Without a zip path the live feed from the LMT provider config is fetched.
 */
import { readFileSync } from 'node:fs';
import { LMT } from '@lkt/core';
import { createPgliteDb, migrate } from '@lkt/db';
import { listFeeds, runStaticIngest } from './index.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const [dataDir, zipPath] = args.filter((a) => !a.startsWith('--'));
if (!dataDir) {
  console.error('usage: cli.ts <pglite-data-dir> [gtfs.zip] [--force]');
  process.exit(2);
}

const db = await createPgliteDb(dataDir);
await migrate(db);
const fetchImpl: typeof fetch | undefined = zipPath
  ? async () => new Response(new Uint8Array(readFileSync(zipPath)), { status: 200 })
  : undefined;

const result = await runStaticIngest({ db, provider: LMT, fetchImpl }, { force });
console.log(JSON.stringify(result, null, 2));
console.table(
  (await listFeeds(db, LMT.id)).map((f) => ({ id: f.id, status: f.status, label: f.label, errors: f.errors, warnings: f.warnings, trips: f.counts.trips })),
);
await db.close();
process.exit(result.status === 'failed' || result.status === 'rejected' ? 1 : 0);
