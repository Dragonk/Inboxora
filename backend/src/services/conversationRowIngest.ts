import { query, withTransaction } from './db.js';
import { toAppError } from '../utils/errors.js';
import { conversationPersistedFields, resolveOwnIdentityAddresses } from './conversationIngestEnvelope.js';
import { _upsertConversationCopyWithClient, conversationSerializeKey } from './conversationPersistence.js';
import { recordConversationIngestFailure } from './conversationIngestFailures.js';
import { recordReplyDiagnostic } from './diagnosticsRing.js';

/**
 * Project one persisted message row into the conversation engine.
 *
 * Kept outside `imapManager`, so a provider adapter can call it without
 * importing the mail manager — `graphMailSync` needs this and importing `imapManager`
 * would create a cycle, since `imapManager` now imports the Graph sync for
 * `ensureFolder`. The persisted row is authoritative for
 * delivery/provider/Sender metadata, and the caller must invoke this **outside** its own
 * transaction, because the conversation engine opens one of its own.
 */
export interface ConversationAccountRow {
  id: string;
  user_id: string;
  imap_host?: string | null;
  mail_transport?: string | null;
  /** The provider connection this account is authorized through; absent for IMAP. */
  provider_connection_id?: string | null;
  /** The account's folder mappings, which the folder resolvers read (trash, archive, drafts). */
  folder_mappings?: unknown;
}

/**
 * The optional raw envelope the ingest paths know about. The parameter is typed as
 * `unknown` because its callers pass their own richer shapes (ImapFlow's fetch object
 * among them) and this function only reads two optional fields; narrowing happens here
 * rather than forcing every caller onto one type.
 */
interface RawConversationEnvelope {
  envelope?: { messageId?: string | null } | null;
  messageId?: string | null;
}

export async function persistConversationCopyForRow(rowId: string, account: ConversationAccountRow, rawMessage?: unknown): Promise<void> {
  const raw = (rawMessage ?? {}) as RawConversationEnvelope & Record<string, unknown>;
  try {
    // Take the same account lock as retry/rebuild BEFORE reading or updating
    // headers. The former standalone UPDATE raced with SERIALIZABLE projections
    // despite their advisory lock, and survived a failed projection's rollback.
    const persisted = await withTransaction(async client => {
      const result = await client.query(`
        SELECT m.*, a.user_id
          FROM messages m
          JOIN email_accounts a ON a.id = m.account_id
         WHERE m.id = $1 AND a.id = $2 AND a.user_id = $3
         FOR UPDATE OF m`, [rowId, account.id, account.user_id]);
      if (result.rows.length !== 1) return null;
      // The persisted row remains authoritative when the caller has only a
      // partial envelope (Sent, provider flag updates and recovery paths).
      const persistenceMessage = { ...result.rows[0], ...raw };
      const metadataAccount = { id: account.id, user_id: account.user_id, imap_host: account.imap_host ?? undefined, mail_transport: account.mail_transport ?? null };
      const envelope = conversationPersistedFields(persistenceMessage, metadataAccount);
      envelope.identities = await resolveOwnIdentityAddresses(client, account.id, persistenceMessage);
      // Avoid creating dead tuples/WAL when a replay supplies unchanged headers
      // or no new header fields at all. NULL still means "keep the stored value".
      await client.query(`
        UPDATE messages
           SET conversation_raw_headers = COALESCE($1, conversation_raw_headers),
               conversation_thread_index = COALESCE($2, conversation_thread_index),
               conversation_thread_topic = COALESCE($3, conversation_thread_topic)
         WHERE id = $4 AND account_id = $5
           AND (conversation_raw_headers IS DISTINCT FROM COALESCE($1, conversation_raw_headers)
             OR conversation_thread_index IS DISTINCT FROM COALESCE($2, conversation_thread_index)
             OR conversation_thread_topic IS DISTINCT FROM COALESCE($3, conversation_thread_topic))`,
      [envelope.conversation_raw_headers, envelope.conversation_thread_index, envelope.conversation_thread_topic, rowId, account.id]);
      await _upsertConversationCopyWithClient(client, result.rows[0], {
        identities: envelope.identities,
        provider: envelope.provider,
        userId: account.user_id,
      });
      await client.query(
        'UPDATE conversation_ingest_failures SET resolved_at = NOW(), updated_at = NOW() WHERE user_id = $1 AND message_row_id = $2 AND resolved_at IS NULL',
        [account.user_id, rowId],
      );
      return result.rows[0];
    }, { serializable: true, serializeKey: conversationSerializeKey(account.user_id, account.id) });
    if (!persisted) return;
    // Diagnostic observation must never downgrade a successful projection into
    // an ingest failure or queue an unnecessary repair.
    try {
      const parentHeader = typeof persisted.in_reply_to === 'string' ? persisted.in_reply_to : null;
      if (parentHeader) {
      const verdict = await query<{
        legacy_thread_matched: boolean; conversation_matched: boolean; provider_thread_matched: boolean;
      }>(
        `SELECT EXISTS (
           SELECT 1 FROM messages child JOIN messages parent
             ON parent.account_id = child.account_id AND parent.message_id = child.in_reply_to
            WHERE child.id = $1 AND parent.thread_id IS NOT NULL AND parent.thread_id = child.thread_id
         ) AS legacy_thread_matched,
         EXISTS (
           SELECT 1 FROM messages child JOIN messages parent
             ON parent.account_id = child.account_id AND parent.message_id = child.in_reply_to
            WHERE child.id = $1 AND parent.conversation_id IS NOT NULL AND parent.conversation_id = child.conversation_id
         ) AS conversation_matched,
         EXISTS (
           SELECT 1 FROM messages child JOIN messages parent
             ON parent.account_id = child.account_id AND parent.message_id = child.in_reply_to
            WHERE child.id = $1 AND parent.provider_thread_id IS NOT NULL AND parent.provider_thread_id = child.provider_thread_id
         ) AS provider_thread_matched`,
        [rowId],
      );
      const state = verdict.rows[0];
      const transport = account.mail_transport === 'microsoft_graph' ? 'microsoft_graph'
        : account.mail_transport === 'gmail_api' ? 'gmail_api' : 'smtp';
      recordReplyDiagnostic({
        event: 'mail_reply_ingested', accountId: account.id, transport, sendKind: 'reply',
        replyParentPresent: true, parentRfcMessageIdPresent: true,
        referencesCount: (String(persisted.thread_references || '').match(/<[^<>\r\n]+>/g) || []).length,
        providerParentResolved: state?.provider_thread_matched === true,
        providerResolution: transport === 'microsoft_graph' ? 'direct' : 'not_applicable',
        transportReplyMode: transport === 'microsoft_graph' ? 'graph_create_reply' : 'rfc_headers',
        legacyThreadMatched: state?.legacy_thread_matched === true,
        conversationMatched: state?.conversation_matched === true,
        providerThreadMatched: state?.provider_thread_matched === true,
      });
      }
    } catch (diagnosticError) {
      // The copy is already persisted; diagnostics are explicitly best effort.
      console.warn('Reply ingest diagnostic failed:', toAppError(diagnosticError).message);
    }
  } catch (caught) {
    const err = toAppError(caught);
    console.error('Conversation persistence error:', err.message);
    await recordConversationIngestFailure({ userId: account.user_id, accountId: account.id, messageRowId: rowId, operation: 'imap-ingest', error: err, diagnostics: { rawMessageId: raw.envelope?.messageId || raw.messageId || null } }).catch(recordErr => console.error('Conversation failure recording error:', recordErr.message));
  }
}

