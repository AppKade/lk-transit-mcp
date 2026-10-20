import { Pool } from '@neondatabase/serverless';
import type { Db, QueryResult } from '@lkt/core';

function wrapClient(q: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> }, begin: (<T>(fn: (tx: Db) => Promise<T>) => Promise<T>) | null): Db {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      const r = await q.query(sql, params && params.length ? params : undefined);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length };
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      if (!begin) return fn(wrapClient(q, null));
      return begin(fn);
    },
  };
}

/**
 * Neon serverless (WebSocket Pool) adapter: supports transactions and multi-statement scripts.
 * In Workers, create the pool per request/invocation and call `close()` (e.g. via ctx.waitUntil) when done.
 */
export function createNeonDb(connectionString: string): Db & { close(): Promise<void> } {
  const pool = new Pool({ connectionString });
  const base = wrapClient(pool, async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(wrapClient(client, null));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });
  return Object.assign(base, { close: () => pool.end() });
}
