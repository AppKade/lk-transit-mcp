import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDb, migrate } from '../src/index.js';

describe('migrations on PGlite', () => {
  let db: Awaited<ReturnType<typeof createPgliteDb>>;
  beforeAll(async () => { db = await createPgliteDb(); });
  afterAll(async () => { await db.close(); });

  it('applies once and is idempotent', async () => {
    expect(await migrate(db)).toEqual(['001_init']);
    expect(await migrate(db)).toEqual([]);
    const t = await db.query<{ table_name: string }>(`select table_name from information_schema.tables where table_schema='public' order by 1`);
    expect(t.rows.map((r) => r.table_name)).toEqual(expect.arrayContaining(['stops', 'routes', 'trips', 'stop_times', 'calendars', 'feed_versions', 'providers']));
  });

  it('rolls back failed transactions', async () => {
    await db.query(`insert into providers (id,name,timezone) values ('x','X','Asia/Colombo')`, ['dummy'].slice(1));
    await expect(db.transaction(async (tx) => {
      await tx.query(`insert into providers (id,name,timezone) values ($1,$2,$3)`, ['y', 'Y', 'Asia/Colombo']);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    const r = await db.query(`select id from providers where id='y'`);
    expect(r.rows).toHaveLength(0);
  });
});
