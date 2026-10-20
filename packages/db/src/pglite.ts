import { PGlite } from '@electric-sql/pglite';
import type { Db, QueryResult } from '@lkt/core';

type Queryable = Pick<PGlite, 'query' | 'exec'>;

function wrap(q: Queryable, tx: (<T>(fn: (tx: Db) => Promise<T>) => Promise<T>) | null): Db {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      if (params === undefined || params.length === 0) {
        // exec supports multi-statement scripts (migrations); results come back per statement.
        const results = await q.exec(sql);
        const last = results[results.length - 1];
        return { rows: ((last?.rows ?? []) as T[]), rowCount: last?.affectedRows ?? last?.rows.length ?? 0 };
      }
      const r = await q.query<T>(sql, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      if (!tx) {
        // Already inside a transaction: nested calls share it.
        return fn(wrap(q, null));
      }
      return tx(fn);
    },
  };
}

/** In-process Postgres (WASM) for tests and zero-install local development. */
export async function createPgliteDb(dataDir?: string): Promise<Db & { close(): Promise<void> }> {
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  const base = wrap(pg, (fn) => pg.transaction(async (t) => fn(wrap(t as unknown as Queryable, null))));
  return Object.assign(base, { close: () => pg.close() });
}
