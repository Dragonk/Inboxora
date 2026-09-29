import { query } from './db.js';
import { populatedMessageSql, visiblePhysicalMessageSql } from './messageVisibility.js';
import { resolveAccountScope, type UnifiedInboxAccount } from './unifiedInbox.js';

export class ThreadAccountNotFoundError extends Error {
  constructor() {
    super('Account not found');
    this.name = 'ThreadAccountNotFoundError';
  }
}

export interface ListThreadMessagesInput {
  userId?: string;
  threadId: string;
  accountId?: string | null;
  unified?: boolean;
}

/**
 * Expand the same account-scoped thread identity returned by listMessages.
 * Every child is one actionable physical message. Equal RFC Message-IDs cannot
 * hide distinct provider IDs or IMAP UIDs. Only proven legacy aliases are hidden.
 * Expansion includes all folders; folder/category/unread filters select heads,
 * not children, so replies and the full physical action membership stay visible.
 */
export async function listThreadMessages({ userId, threadId, accountId, unified = false }: ListThreadMessagesInput) {
  const accounts = await query<UnifiedInboxAccount>(
    'SELECT id, include_in_unified_inbox FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [userId],
  );
  if (accountId && !accounts.rows.some(account => account.id === accountId)) {
    throw new ThreadAccountNotFoundError();
  }
  const accountIds = accountId
    ? [accountId]
    : unified
      ? resolveAccountScope(accounts.rows).accountIds
      : accounts.rows.map(account => account.id);
  if (!accountIds.length) return { messages: [] };

  const threadIdentity = accountId ? 'm.thread_key' : "(m.account_id::text || ':' || m.thread_key)";
  const result = await query(`
    SELECT m.id, m.uid, m.folder, m.is_archived,
           ARRAY(SELECT ml.folder_path FROM message_labels ml
                 WHERE ml.message_id = m.id AND ml.account_id = m.account_id) AS folder_paths,
           m.message_id, m.thread_id, m.thread_key, m.subject,
           m.from_name, m.from_email, m.to_addresses, m.cc_addresses,
           m.reply_to, m.in_reply_to, m.thread_references,
           m.date, m.snippet, m.is_read, m.is_starred,
           m.has_attachments, m.account_id, m.category,
           m.spam_verdict, m.spam_score_ml, m.spam_score_blended,
           m.list_unsubscribe, m.list_unsubscribe_post, m.unsubscribed_at, m.delivery_addresses,
           a.name AS account_name, a.email_address AS account_email, a.color AS account_color
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.is_deleted = false
      AND ${visiblePhysicalMessageSql}
      AND ${populatedMessageSql}
      AND m.account_id = ANY($1)
      AND ${threadIdentity} = $2
    ORDER BY m.date ASC NULLS LAST, m.id ASC
  `, [accountIds, threadId]);
  return { messages: result.rows };
}
