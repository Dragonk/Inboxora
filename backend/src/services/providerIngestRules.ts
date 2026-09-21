import { query } from './db.js';
import { applyBlockList, applyInboxRules } from './inboxRules.js';
import type { ConversationAccountRow } from './conversationRowIngest.js';
import type { EmailAccountRow } from './imapManager.js';

/**
 * Run the ingest rules over the INBOX rows a provider sync just stored (MAIL-01).
 *
 * The IMAP sync has always done this for the messages it fetched; a native account stored its mail and applied
 * nothing, so a blocked sender's mail still arrived and a user's rules never ran. The engine is transport-neutral
 * now — it acts through `MailActionPort` — so the provider-specific part is this call: pick the run's INBOX rows
 * and hand them to the same engine, in the same order (block list, then rules), with a port that speaks to Gmail
 * or Microsoft Graph.
 *
 * A rule's actions (move, label, archive, mark read, star, delete, forward) all reach the provider through that
 * port; `forward` additionally uses the forwarder, which already reads a native message's body through its own
 * provider reader. A failure is logged, never thrown: an ingest side effect must not fail the synchronisation that
 * stored the mail, which is the rule the IMAP path already follows.
 */
export async function applyIngestRulesToRows(input: {
  userId: string;
  connectionId: string;
  account: ConversationAccountRow;
  /** The local folder the rows were stored in; only its INBOX is a block-list target. */
  folder: string;
  rowIds: readonly string[];
  /** Named in the log so an operator can tell which provider's ingest failed. */
  providerName?: string;
}): Promise<{ considered: number; blocked: number; ruled: number }> {
  if (input.rowIds.length === 0) return { considered: 0, blocked: 0, ruled: 0 };
  const rows = await query<{ id: string; uid: number | string | null; folder: string; from_email: string | null; is_read: boolean | null }>(
    `SELECT id, uid, folder, from_email, is_read FROM messages
      WHERE id = ANY($1::uuid[]) AND account_id = $2 AND folder = $3 AND is_deleted = false`,
    [input.rowIds, input.account.id, input.folder],
  );
  if (rows.rows.length === 0) return { considered: 0, blocked: 0, ruled: 0 };

  const messages = rows.rows.map(row => ({
    id: row.id,
    // The engine's `uid` is the number the row carries; a provider row always has one because the sync derives
    // it. A row without one is skipped rather than given a made-up number, which would address nothing.
    uid: Number(row.uid ?? 0),
    folder: row.folder,
    fromEmail: row.from_email ?? '',
    is_read: row.is_read ?? false,
  })).filter(message => Number.isFinite(message.uid) && message.uid > 0);
  // Loaded lazily: `mailActionPort` reaches the provider move services, which reach back into the synchronisers
  // that call this hook, so a module-level import would close a cycle. Deferring it to first use keeps the
  // dependency a call-time one.
  const { providerMailActionPort } = await import('./mailActionPort.js');
  const port = providerMailActionPort({
    userId: input.userId,
    // The port reads the transport and the connection; both come from the account row the sync loaded.
    account: {
      id: input.account.id,
      user_id: input.account.user_id,
      mail_transport: input.account.mail_transport ?? null,
      provider_connection_id: input.account.provider_connection_id ?? null,
    } as EmailAccountRow,
    connectionId: input.connectionId,
  });

  const ruleAccount = {
    id: input.account.id,
    user_id: input.account.user_id,
    folder_mappings: (input.account.folder_mappings ?? null) as never,
  };
  try {
    // The block list first, then the rules — the order the IMAP path uses, so a blocked sender never reaches a
    // rule and a rule's own actions see the messages the block list left.
    const afterBlockList = await applyBlockList(messages, ruleAccount, port);
    const blocked = messages.length - afterBlockList.length;
    const ruled = await applyInboxRules(afterBlockList, ruleAccount, port);
    return { considered: messages.length, blocked, ruled: afterBlockList.length - ruled.remaining.length };
  } catch (caught) {
    console.warn(
      `Ingest rules failed for ${input.providerName ?? 'provider'} account ${input.account.id}:`,
      caught instanceof Error ? caught.message : caught,
    );
    return { considered: messages.length, blocked: 0, ruled: 0 };
  }
}
