import type { PoolClient } from 'pg';

export const STORAGE_RETENTION_FIELDS = {
  mail_body_cache_days: { default: 30, min: 0, max: 3650 },
  dav_history_days: { default: 30, min: 1, max: 3650 },
  dav_history_max_entries: { default: 10_000, min: 100, max: 100_000 },
  auth_log_days: { default: 90, min: 1, max: 3650 },
  conversation_audit_days: { default: 30, min: 1, max: 3650 },
  resolved_ingest_error_days: { default: 7, min: 1, max: 3650 },
  completed_outbox_payload_days: { default: 7, min: 1, max: 3650 },
} as const;
export type RetentionKey = keyof typeof STORAGE_RETENTION_FIELDS;
export type StorageRetentionPolicy = Record<RetentionKey, number>;
export const RETENTION_KEYS = Object.keys(STORAGE_RETENTION_FIELDS) as RetentionKey[];

export function parseRetentionValue(key: RetentionKey, value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,5})$/.test(value))) return null;
  const n = Number(value), spec = STORAGE_RETENTION_FIELDS[key];
  return Number.isInteger(n) && n >= spec.min && n <= spec.max ? n : null;
}

export function parseRetentionPatch(body: unknown): Partial<StorageRetentionPolicy> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected a retention settings object');
  const entries = Object.entries(body);
  if (!entries.length) throw new Error('No retention settings provided');
  const patch: Partial<StorageRetentionPolicy> = {};
  for (const [key, value] of entries) {
    if (!Object.hasOwn(STORAGE_RETENTION_FIELDS, key)) throw new Error(`Unknown retention setting: ${key}`);
    const k = key as RetentionKey, n = parseRetentionValue(k, value);
    if (n === null) throw new Error(`Invalid ${key}: expected an integer from ${STORAGE_RETENTION_FIELDS[k].min} to ${STORAGE_RETENTION_FIELDS[k].max}`);
    patch[k] = n;
  }
  return patch;
}

/** Re-read on each bounded cleanup batch. Invalid stored policy stops cleanup;
 * silently guessing a shorter retention period would risk deleting extra data. */
export async function readStorageRetentionPolicy(client: Pick<PoolClient, 'query'>): Promise<StorageRetentionPolicy> {
  const rows = await client.query<{key: string; value: string}>('SELECT key, value FROM system_settings WHERE key = ANY($1::text[])', [RETENTION_KEYS]);
  const values = new Map(rows.rows.map(row => [row.key, row.value]));
  const policy = {} as StorageRetentionPolicy;
  for (const key of RETENTION_KEYS) {
    const raw = values.get(key), n = raw === undefined ? STORAGE_RETENTION_FIELDS[key].default : parseRetentionValue(key, raw);
    if (n === null) throw new Error(`Invalid stored retention setting: ${key}`);
    policy[key] = n;
  }
  return policy;
}
