import { query } from './db.js';
import { providerIntegrationsEnabled, readProviderSwitches } from './providerSwitches.js';
import { googleConfigFromEnv, isGoogleConfigured } from './providerAuthService.js';

/**
 * The Google mail migration recommendation (P09, per user and per account).
 *
 * The plan's notice is deliberately two-sided: "ignore" is a dismissal the interface owns and forgets,
 * while "do not show again" is a **server-side** suppression that must survive a reload and a second
 * device. `account_notice_preferences` (migration 0101) already has exactly the shape that needs —
 * `UNIQUE (user_id, account_id, notice_type)` — so this module adds no table and no migration.
 *
 * Only one notice type exists here, and the column's `CHECK` allows only that one:
 * `google_mail_api_recommendation`. There is deliberately **no** notice type for the Microsoft
 * requirement, so that notice cannot be suppressed: the schema's closed set is what keeps a
 * requirement from being dismissed, and it must stay closed. Widening the `CHECK` would silently make
 * the Microsoft requirement optional.
 */

export type AccountNoticeType = 'google_mail_api_recommendation';

export const GOOGLE_MAIL_RECOMMENDATION: AccountNoticeType = 'google_mail_api_recommendation';

/** An active notice. The wording is the interface's; the server sends identity, not copy. */
export interface AccountNotice {
  accountId: string;
  address: string;
  noticeType: AccountNoticeType;
}

/**
 * Whether the recommendation may be shown at all.
 *
 * Recommending a migration to a transport this installation cannot offer is a dead end, so the same
 * three facts the Google integration card reports as readiness are required here: the operator's layer
 * switch, the provider/method switch, and a configured OAuth client. Read in one place so the notice
 * and the connector can never disagree about whether the destination exists.
 */
export async function googleMailRecommendationAvailable(): Promise<boolean> {
  if (!providerIntegrationsEnabled()) return false;
  const switches = await readProviderSwitches('google');
  if (!switches.enabled || !switches.apiEnabled) return false;
  return isGoogleConfigured(googleConfigFromEnv());
}

/**
 * The active recommendation for a user's own accounts.
 *
 * A Google mailbox is identified the way the rest of the app identifies one: an account authorized
 * with Google (`oauth_provider = 'google'`) or one whose IMAP host is a Gmail host. It must still be
 * on `imap_smtp` — a NULL transport is the pre-v4 default and means IMAP+SMTP — and it must be
 * enabled, because recommending a transport change for a mailbox that is switched off is noise.
 */
export async function listActiveGoogleMailRecommendations(userId: string): Promise<AccountNotice[]> {
  if (!(await googleMailRecommendationAvailable())) return [];
  const result = await query<{ id: string; email_address: string }>(
    `SELECT a.id, a.email_address
       FROM email_accounts a
       LEFT JOIN account_notice_preferences p
              ON p.user_id = a.user_id AND p.account_id = a.id AND p.notice_type = $2
      WHERE a.user_id = $1
        AND a.enabled = true
        AND COALESCE(a.mail_transport, 'imap_smtp') = 'imap_smtp'
        AND (
          a.oauth_provider = 'google'
          OR lower(COALESCE(a.imap_host, '')) LIKE '%.gmail.com'
          OR lower(COALESCE(a.imap_host, '')) LIKE '%.googlemail.com'
        )
        AND COALESCE(p.suppressed, false) = false
      ORDER BY a.email_address ASC`,
    [userId, GOOGLE_MAIL_RECOMMENDATION],
  );
  return result.rows.map(row => ({
    accountId: row.id,
    address: row.email_address,
    noticeType: GOOGLE_MAIL_RECOMMENDATION,
  }));
}

export type SuppressNoticeResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * "Do not show again" for one account.
 *
 * Ownership is checked before the write, so an account id that is not the caller's is a `404` rather
 * than a foreign-key error. The revision is bumped on every suppression so a client that cached the
 * notice can tell its preference changed.
 */
export async function suppressGoogleMailRecommendation(userId: string, accountId: string): Promise<SuppressNoticeResult> {
  const account = await query<{ id: string }>(
    'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, userId],
  );
  if (!account.rows.length) return { ok: false, status: 404, error: 'Account not found' };
  await query(
    `INSERT INTO account_notice_preferences (user_id, account_id, notice_type, suppressed, revision)
     VALUES ($1, $2, $3, true, 1)
     ON CONFLICT (user_id, account_id, notice_type) DO UPDATE
       SET suppressed = true,
           revision = account_notice_preferences.revision + 1,
           updated_at = NOW()`,
    [userId, accountId, GOOGLE_MAIL_RECOMMENDATION],
  );
  return { ok: true };
}
