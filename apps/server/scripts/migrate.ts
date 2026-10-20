/**
 * Applies DB migrations and seeds the provider rows:  DATABASE_URL=postgres://... npx tsx apps/server/scripts/migrate.ts
 * Run it before deploying a Worker version that needs a new migration (the Worker never migrates at runtime).
 */
import { PROVIDERS } from '@lkt/core';
import { createNeonDb, migrate } from '@lkt/db';
import { ensureProvider } from '@lkt/ingest';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const db = createNeonDb(url);
try {
  const applied = await migrate(db);
  for (const p of Object.values(PROVIDERS)) await ensureProvider(db, p);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'schema up to date');
} finally {
  await db.close();
}
