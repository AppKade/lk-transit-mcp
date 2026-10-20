import type { RealtimeSnapshot } from './model.js';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/**
 * Minimal SQL surface shared by the Neon driver (production), PGlite (tests/local) and node-postgres.
 * Placeholders are Postgres style: $1, $2 ...
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Runs `fn` in a single transaction; rolls back if it throws. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

/** Contract between the realtime side (ingest) and the query layer. */
export interface RealtimeSource {
  getSnapshot(provider: string): Promise<RealtimeSnapshot>;
}

/** Injectable clock so freshness and arrival logic is testable. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
