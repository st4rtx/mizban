import pg from 'pg';

// Keep DATE/INT8 predictable: counts come back as numbers, dates as strings.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string, max = 10): Db {
  return new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000, statement_timeout: 10_000 });
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization failure, deadlock

/**
 * Runs `fn` in a transaction scoped to one restaurant. app.restaurant_id is set with
 * is_local=true so it dies with the transaction and can never leak to the next borrower
 * of a pooled connection. Row-level security policies read it; without it nothing matches.
 */
export async function withTenant<T>(db: Db, restaurantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const tx = await db.connect();
    try {
      await tx.query('BEGIN');
      await tx.query("SELECT set_config('app.restaurant_id', $1, true)", [restaurantId]);
      const out = await fn(tx);
      await tx.query('COMMIT');
      return out;
    } catch (err) {
      await tx.query('ROLLBACK').catch(() => undefined);
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < 2) continue;
      throw err;
    } finally {
      tx.release();
    }
  }
}
