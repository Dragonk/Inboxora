import { query } from './db.js';
import { isUuid } from '../utils/uuid.js';
/** Validate owned sender identities before any preferences are persisted. */
export async function calendarPreferencePatch(userId: string, body: Record<string, unknown>): Promise<Record<string, string | boolean>> {
  const patch: Record<string, string | boolean> = {};
  const invalid = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }); };
  if (body.calendarShowAgenda !== undefined) {
    if (typeof body.calendarShowAgenda !== 'boolean') invalid('calendarShowAgenda must be a boolean');
    patch.calendarShowAgenda = body.calendarShowAgenda as boolean;
  }
  if (body.calendarInviteAccountId !== undefined || body.calendarInviteAliasId !== undefined) {
    const accountId = body.calendarInviteAccountId;
    const aliasId = body.calendarInviteAliasId ?? '';
    if (typeof accountId !== 'string' || (accountId !== '' && !isUuid(accountId))) invalid('Invalid invitation sender account');
    if (typeof aliasId !== 'string' || (aliasId !== '' && !isUuid(aliasId))) invalid('Invalid invitation sender alias');
    if (!accountId && aliasId) invalid('An invitation alias requires an account');
    if (accountId) {
      const owned = await query<{ id: string }>(`SELECT a.id FROM email_accounts a
        WHERE a.id = $1 AND a.user_id = $2 AND a.enabled = true
          AND (NULLIF(a.smtp_host, '') IS NOT NULL OR a.mail_transport IN ('gmail_api', 'microsoft_graph'))
          AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM account_aliases x WHERE x.id = $3 AND x.account_id = a.id))`,
      [accountId, userId, aliasId || null]);
      if (!owned.rows.length) invalid('The selected invitation sender is unavailable');
    }
    patch.calendarInviteAccountId = accountId as string;
    patch.calendarInviteAliasId = aliasId as string;
  }
  return patch;
}
