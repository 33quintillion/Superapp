import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { migrate } from '../src/database/migrator';
import { TEST_ENV } from './helpers';

// Uses a throwaway schema so it does not disturb the shared test schema.
describe('migrator', () => {
  const pool = new Pool({ connectionString: TEST_ENV.DATABASE_URL, max: 1 });
  beforeAll(async () => {
    await pool.query('DROP SCHEMA IF EXISTS migtest CASCADE; CREATE SCHEMA migtest');
    pool.on('connect', (c) => c.query('SET search_path TO migtest'));
  });
  afterAll(async () => {
    await pool.query('DROP SCHEMA IF EXISTS migtest CASCADE');
    await pool.end();
  });

  it('applies pending migrations once and is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int);');
    expect(await migrate(pool, dir)).toEqual(['0001_a.sql']);
    expect(await migrate(pool, dir)).toEqual([]);
  });

  it('refuses a migration edited after it was applied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int, extra int);');
    await expect(migrate(pool, dir)).rejects.toThrow(/modified/);
  });

  it('rolls back a failing migration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int);');
    writeFileSync(join(dir, '0002_bad.sql'), 'CREATE TABLE b (id int); SELECT nope_not_a_function();');
    await expect(migrate(pool, dir)).rejects.toThrow(/0002_bad/);
    const { rows } = await pool.query(`SELECT to_regclass('migtest.b') AS t`);
    expect(rows[0].t).toBeNull();
  });
});
