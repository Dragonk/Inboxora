import type { PoolClient } from 'pg';

/**
 * Test double for a transaction client: a case exercises only the few methods it uses, while
 * withTransaction hands the callback a real PoolClient. \`PoolClientDouble\` merges the real interface
 * onto an empty runtime object, so assigning the test parts yields the full type without an
 * assertion and leaves the caller's object untouched at runtime.
 */
interface PoolClientDouble extends PoolClient {}
class PoolClientDouble {}

export function mockPoolClient<T extends object>(parts: T): PoolClient & T {
  return Object.assign(parts, new PoolClientDouble());
}
