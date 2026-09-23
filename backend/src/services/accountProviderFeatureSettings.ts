import { query, withTransaction } from './db.js';

/** Optional provider services deliberately enabled for one mailbox. */
export type AccountProviderService = 'calendars' | 'contacts';

const ALL_SERVICES: readonly AccountProviderService[] = ['calendars', 'contacts'];
const SERVICES = new Set<AccountProviderService>(ALL_SERVICES);

export function isAccountProviderService(value: unknown): value is AccountProviderService {
  return typeof value === 'string' && SERVICES.has(value as AccountProviderService);
}

export interface AccountProviderFeatureSetting {
  feature: AccountProviderService;
  enabled: boolean;
  revision: number;
}

export async function accountProviderFeatureSettings(accountId: string): Promise<AccountProviderFeatureSetting[]> {
  const result = await query<{ feature: AccountProviderService; enabled: boolean; revision: number | string }>(
    `SELECT feature, enabled, revision
       FROM account_provider_feature_settings
      WHERE account_id = $1
      ORDER BY feature`,
    [accountId],
  );
  const known = new Map(result.rows.map(row => [row.feature, {
    feature: row.feature,
    enabled: row.enabled === true,
    revision: Number(row.revision),
  }]));
  return ALL_SERVICES.map(feature => known.get(feature) ?? { feature, enabled: false, revision: 0 });
}

/**
 * Persist one user's intent. Ownership is checked in the same transaction as the
 * revision bump, so an id from another account cannot be used to schedule work.
 */
export async function setAccountProviderFeatureSetting(input: {
  userId: string;
  accountId: string;
  feature: AccountProviderService;
  enabled: boolean;
}): Promise<AccountProviderFeatureSetting | null> {
  return withTransaction(async client => {
    const account = await client.query<{ id: string }>(
      'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [input.accountId, input.userId],
    );
    if (!account.rows[0]) return null;
    const result = await client.query<{ feature: AccountProviderService; enabled: boolean; revision: number | string }>(
      `INSERT INTO account_provider_feature_settings (account_id, feature, enabled, revision, updated_at)
       VALUES ($1, $2, $3, 1, NOW())
       ON CONFLICT (account_id, feature) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             revision = account_provider_feature_settings.revision + 1,
             updated_at = NOW()
       RETURNING feature, enabled, revision`,
      [input.accountId, input.feature, input.enabled],
    );
    const row = result.rows[0]!;
    return { feature: row.feature, enabled: row.enabled === true, revision: Number(row.revision) };
  });
}

/**
 * Resolve current optional-service intent for a provider connection at the last
 * possible boundary before a provider call. A standalone connection (one that is
 * not owned by an email account) retains its explicit legacy flow; an account-owned
 * connection with no setting is fail-closed after migration.
 */
export async function providerConnectionFeatureEnabled(input: {
  userId: string;
  connectionId: string;
  feature: AccountProviderService;
}): Promise<boolean> {
  const result = await query<{ account_count: number | string; enabled_count: number | string }>(
    `SELECT COUNT(a.id) AS account_count,
            COUNT(a.id) FILTER (WHERE s.enabled = true) AS enabled_count
       FROM email_accounts a
       LEFT JOIN account_provider_feature_settings s
         ON s.account_id = a.id AND s.feature = $3
      WHERE a.user_id = $1 AND a.provider_connection_id = $2`,
    [input.userId, input.connectionId, input.feature],
  );
  const row = result.rows[0];
  if (!row || Number(row.account_count) === 0) return true;
  return Number(row.enabled_count) > 0;
}

/** Feature settings mapped to existing collection kinds used by provider adapters. */
export function collectionKindForAccountProviderService(feature: AccountProviderService): 'calendar' | 'address_book' {
  return feature === 'calendars' ? 'calendar' : 'address_book';
}
