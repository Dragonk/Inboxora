import { query } from './db.js';
import { applyBlockList, applyInboxRules, ruleDataRequirementsForAccount } from './inboxRules.js';
import { enqueueProviderRuleDeferral } from './providerRuleDeferred.js';
import { providerNativeRulesEnabled } from './providerSwitches.js';
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
  /** The deferred worker already hydrated its claimed row and must not enqueue it again. */
  skipDeferral?: boolean;
}): Promise<{ considered: number; blocked: number; ruled: number; rulesSkipped: boolean }> {
  if (input.rowIds.length === 0) return { considered: 0, blocked: 0, ruled: 0, rulesSkipped: false };
  const rows = await query<{
    id: string; uid: number | string | null; folder: string; from_email: string | null; from_name: string | null;
    subject: string | null; to_addresses: unknown; has_attachments: boolean | null; is_read: boolean | null; parsed_headers: unknown; body_text: string | null;
  }>(
    `SELECT id, uid, folder, from_email, is_read, from_name, subject, to_addresses, has_attachments, parsed_headers, body_text FROM messages
      WHERE id = ANY($1::uuid[]) AND account_id = $2 AND folder = $3 AND is_deleted = false`,
    [input.rowIds, input.account.id, input.folder],
  );
  if (rows.rows.length === 0) return { considered: 0, blocked: 0, ruled: 0, rulesSkipped: false };

  // Native sync projections intentionally do not always fetch a full body or every RFC
  // header. If an enabled rule needs either unknown value, durably park the complete
  // message before *any* block-list or rule effect can reach the provider. Retrying the
  // record later retries reads only; it cannot replay an uncertain action.
  if (!input.skipDeferral && providerNativeRulesEnabled()) {
    try {
      const requirements = await ruleDataRequirementsForAccount(input.account.user_id, input.account.id);
      const transport = input.account.mail_transport;
      if ((transport === 'gmail_api' || transport === 'microsoft_graph') && (requirements.needsBody || requirements.needsHeaders)) {
        const deferred = rows.rows.filter(row =>
          (requirements.needsBody && row.body_text === null) ||
          (requirements.needsHeaders && (row.parsed_headers === null || typeof row.parsed_headers !== 'object')),
        );
        if (deferred.length > 0) {
          for (const row of deferred) {
            await enqueueProviderRuleDeferral({
              messageId: row.id, accountId: input.account.id, userId: input.account.user_id,
              connectionId: input.connectionId, transport, requirements,
            });
          }
          return { considered: rows.rows.length, blocked: 0, ruled: 0, rulesSkipped: false };
        }
      }
    } catch (caught) {
      console.warn(`Ingest rule deferral failed for ${input.providerName ?? 'provider'} account ${input.account.id}:`, caught instanceof Error ? caught.message : caught);
      // Do not apply an action when we could not prove the required input is present.
      return { considered: rows.rows.length, blocked: 0, ruled: 0, rulesSkipped: false };
    }
  }

  const messages = rows.rows.map(row => ({
    id: row.id,
    ...(typeof row.subject === 'string' ? { subject: row.subject } : {}),
    ...(typeof row.from_name === 'string' ? { fromName: row.from_name } : {}),
    ...(typeof row.has_attachments === 'boolean' ? { hasAttachments: row.has_attachments } : {}),
    ...(row.parsed_headers !== null && typeof row.parsed_headers === 'object' ? { parsedHeaders: row.parsed_headers } : {}),
    ...(Array.isArray(row.to_addresses) ? {
      to: row.to_addresses.map(value => {
        if (!value || typeof value !== 'object') return { email: '' };
        const recipient = value as { address?: unknown; email?: unknown; name?: unknown };
        return {
          email: typeof recipient.email === 'string' ? recipient.email : typeof recipient.address === 'string' ? recipient.address : '',
          ...(typeof recipient.name === 'string' ? { name: recipient.name } : {}),
        };
      }),
    } : {}),
    // The row's own uid, **as stored**: a provider's derived value can exceed what a JavaScript number holds
    // exactly, and rounding it would address a message that does not exist. A row without one is skipped rather
    // than given a made-up value.
    uid: String(row.uid ?? ''),
    folder: row.folder,
    ...(typeof row.from_email === 'string' ? { fromEmail: row.from_email } : {}),
    ...(typeof row.is_read === 'boolean' ? { is_read: row.is_read } : {}),
  })).filter(message => message.uid.length > 0);
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
    // The rules are opt-in for a native account: a global rule can delete mail, and enabling them silently would
    // change what an existing account does after an upgrade (see `providerNativeRulesEnabled`).
    const rulesSkipped = !providerNativeRulesEnabled();
    if (rulesSkipped) {
      return { considered: messages.length, blocked, ruled: 0, rulesSkipped };
    }
    const ruled = await applyInboxRules(afterBlockList, ruleAccount, port);
    return { considered: messages.length, blocked, ruled: afterBlockList.length - ruled.remaining.length, rulesSkipped };
  } catch (caught) {
    console.warn(
      `Ingest rules failed for ${input.providerName ?? 'provider'} account ${input.account.id}:`,
      caught instanceof Error ? caught.message : caught,
    );
    return { considered: messages.length, blocked: 0, ruled: 0, rulesSkipped: false };
  }
}
