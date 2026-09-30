import { query } from './db.js';
import type { EmailAccountRow } from './imapManager.js';

export const IMAP_TRANSPORT_GUARD = "(mail_transport IS NULL OR mail_transport = 'imap_smtp')";
const CHANGED = 'IMAP_ACCOUNT_CHANGED';

export function isImapAccount(account: Pick<EmailAccountRow, 'mail_transport' | 'protocol'>): boolean {
  return (account.mail_transport == null || account.mail_transport === 'imap_smtp')
    && (account.protocol == null || account.protocol === 'imap');
}
export function assertImapAccount(account: EmailAccountRow): void {
  if (!isImapAccount(account) || account.enabled === false) throw changedError();
}
function changedError() {
  return Object.assign(new Error('IMAP work belongs to an inactive or replaced account transport'), { code: CHANGED });
}
export function isImapAccountChanged(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === CHANGED;
}

/** Timer arguments can predate a cutover. Never use their endpoint/credentials
 * when the authoritative row no longer belongs to that IMAP generation. */
export async function readCurrentImapAccount(expected: EmailAccountRow): Promise<EmailAccountRow | null> {
  if (!isImapAccount(expected) || expected.enabled === false) return null;
  const result = await query<EmailAccountRow>('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [expected.id, expected.user_id]);
  const current = result.rows[0];
  if (!current || !current.enabled || !isImapAccount(current)) return null;
  if (expected.transport_generation != null && String(current.transport_generation) !== String(expected.transport_generation)) throw changedError();
  return current;
}

/** Recheck after queue/DNS/handshake waits. A completion from the retired
 * transport must never install a new IMAP client or overwrite native health. */
export async function assertCurrentImapAccount(account: EmailAccountRow): Promise<void> {
  assertImapAccount(account);
  const result = await query<{id: string}>(`SELECT id FROM email_accounts
    WHERE id = $1 AND user_id = $2 AND enabled = true AND protocol = 'imap'
      AND ${IMAP_TRANSPORT_GUARD} AND transport_generation = $3::bigint
      AND imap_host IS NOT DISTINCT FROM $4::text`,
  [account.id, account.user_id, String(account.transport_generation ?? 1), account.imap_host ?? null]);
  if (!result.rows.length) throw changedError();
}
