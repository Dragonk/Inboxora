import type { PoolClient } from 'pg';

export const MAIL_PREFETCH_SETTING_KEY = 'mail_body_prefetch_limit';
export const DEFAULT_MAIL_PREFETCH_LIMIT = 25;
export const MAX_MAIL_PREFETCH_LIMIT = 100;

/** Accept complete integers only; never turn 25.5 / "25oops" / null into a limit. */
export function parseMailPrefetchLimit(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,2})$/.test(value))) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_MAIL_PREFETCH_LIMIT ? parsed : null;
}

/** Missing settings use the default. Corrupt stored values disable speculation
 * rather than silently issuing more provider requests than the admin intended. */
export function storedMailPrefetchLimit(value: unknown): number {
  return value === undefined ? DEFAULT_MAIL_PREFETCH_LIMIT : parseMailPrefetchLimit(value) ?? 0;
}

/** No process-local cache: the next batch on every backend observes a committed
 * administrator change without restart or replica-specific cache invalidation. */
export async function readMailPrefetchLimit(client: Pick<PoolClient, 'query'>, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (env.MAIL_BODY_PREFETCH === 'off') return 0;
  const result = await client.query<{ value: string }>('SELECT value FROM system_settings WHERE key = $1', [MAIL_PREFETCH_SETTING_KEY]);
  return storedMailPrefetchLimit(result.rows[0]?.value);
}
