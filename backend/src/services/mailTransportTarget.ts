import { query } from './db.js';
import { providerIntegrationsEnabled } from './providerSwitches.js';
import { isMicrosoftConfigured, microsoftConfigFromEnv } from './providerAuthService.js';

/**
 * Which transport an account's mail operations must use, resolved once and enforced in one place.
 *
 * Every provider-backed mail path needs the same three answers before it can act: an account with no
 * transport recorded is IMAP (the only thing a pre-v4 row could have been); a native account needs the
 * layer switched on, the provider configured and its connection linked — and each of those missing is a
 * different refusal with a different remedy. Keeping the resolution here means the sync routes and the
 * draft route cannot drift into disagreeing about when a native account is usable.
 */
export type MailTransportTarget =
  | { kind: 'imap' }
  | { kind: 'graph'; connectionId: string; config: ReturnType<typeof microsoftConfigFromEnv> }
  | { kind: 'refused'; status: number; error: string };

export async function resolveMailTransportForSync(userId: string, accountId: string): Promise<MailTransportTarget> {
  const check = await query<{ id: string; mail_transport: string | null; provider_connection_id: string | null }>(
    'SELECT id, mail_transport, provider_connection_id FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, userId],
  );
  if (!check.rows.length) return { kind: 'refused', status: 404, error: 'Account not found' };
  const account = check.rows[0];
  if (account.mail_transport !== 'microsoft_graph') return { kind: 'imap' };
  if (!providerIntegrationsEnabled()) {
    return { kind: 'refused', status: 403, error: 'Provider integrations are disabled on this installation' };
  }
  const config = microsoftConfigFromEnv();
  if (!isMicrosoftConfigured(config)) {
    return { kind: 'refused', status: 409, error: 'Microsoft API is not configured by the administrator' };
  }
  if (!account.provider_connection_id) {
    return { kind: 'refused', status: 409, error: 'This account is not linked to a Microsoft connection' };
  }
  return { kind: 'graph', connectionId: account.provider_connection_id, config };
}
