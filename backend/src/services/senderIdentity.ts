import { query } from './db.js';
import type { EmailAccountRow } from './imapManager.js';

export type SenderIdentity = {
  aliasId: string | null;
  fromName: string | null | undefined;
  fromEmail: string;
  fromReplyTo: string | null;
  fromSignature: string | null | undefined;
};

/** Resolve an explicitly selected sender without silently changing identity. */
export async function resolveSenderIdentity(account: EmailAccountRow, aliasId?: string | null): Promise<SenderIdentity> {
  const fallback: SenderIdentity = {
    aliasId: null,
    fromName: account.sender_name || account.name,
    fromEmail: account.email_address || '',
    fromReplyTo: null,
    fromSignature: account.signature,
  };
  if (!aliasId) return fallback;

  const aliasResult = await query<{ name?: string | null; email?: string | null; reply_to?: string | null; signature?: string | null }>(
    'SELECT name, email, reply_to, signature FROM account_aliases WHERE id = $1 AND account_id = $2',
    [aliasId, account.id],
  );
  const alias = aliasResult.rows[0];
  if (!alias) throw Object.assign(new Error('Selected sender alias is unavailable'), { status: 409 });
  return {
    aliasId,
    fromName: alias.name,
    fromEmail: alias.email || '',
    fromReplyTo: alias.reply_to || null,
    fromSignature: alias.signature === null ? account.signature : alias.signature,
  };
}
