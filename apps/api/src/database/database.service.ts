import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { APP_CONFIG, AppConfig } from '../config/config';

export type Queryable = Pick<PoolClient, 'query'>;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_MAX });
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = [], db: Queryable = this.pool) {
    return db.query<T>(sql, params);
  }

  async one<T extends QueryResultRow>(sql: string, params: unknown[] = [], db: Queryable = this.pool): Promise<T | null> {
    const res = await db.query<T>(sql, params);
    return res.rows[0] ?? null;
  }

  /** Runs fn inside a transaction; rolls back on any thrown error. */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
