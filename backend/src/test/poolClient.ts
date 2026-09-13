import type { PoolClient } from 'pg';

/**
 * Test double for a transaction client: a case exercises only the few methods it uses, while
 * withTransaction hands the callback a real PoolClient. The cast lives here so no test needs one.
 */
export function mockPoolClient<T extends object>(parts: T): PoolClient & T {
  return parts as unknown as PoolClient & T;
}

