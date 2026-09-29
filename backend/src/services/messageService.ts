import { messageFolderMembershipSql } from './messageFolderMembership.js';
import { populatedMessageSql, visiblePhysicalMessageSql } from './messageVisibility.js';
import { query } from './db.js';
import type { UnifiedInboxAccount } from './unifiedInbox.js';
import { resolveAccountScope } from './unifiedInbox.js';

export async function listMessages({ userId, accountId, folder = 'INBOX', limit = 50, offset = 0, unreadOnly = undefined, threaded = undefined, category = undefined }: { userId?: string; accountId?: string | null; folder?: string; limit?: number; offset?: number; unreadOnly?: boolean | string; threaded?: boolean | string; category?: string | null }) {
  const accountsResult = await query<UnifiedInboxAccount>(
    'SELECT id, include_in_unified_inbox FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [userId]
  );
  const {
    accountIds: scopedAccountIds,
    resolvedAccountId,
  } = resolveAccountScope(accountsResult.rows, accountId);
  if (!scopedAccountIds.length) return { messages: [], total: 0 };

  let whereConditions = ['m.is_deleted = false', visiblePhysicalMessageSql];
  const values = [];
  let p = 1;

  const isSpecificAccount = resolvedAccountId !== null;
  let displayFolderExpr: string;

  if (isSpecificAccount) {
    whereConditions.push(`m.account_id = $${p++}`);
    values.push(resolvedAccountId);
    const folderParam = p++;
    values.push(folder);
    // Gmail has no Archive label. Its archived rows retain their historical folder
    // for identity and legacy constraints, but must not reappear in INBOX. `Archive`
    // is consequently a virtual view for those rows; physical Archive folders keep
    // their normal legacy behaviour.
    if (folder === 'Archive') {
      whereConditions.push(`(m.folder = $${folderParam} OR m.is_archived = true)`);
      displayFolderExpr = `(CASE WHEN m.is_archived THEN 'Archive' ELSE m.folder END)`;
    } else {
      whereConditions.push('m.is_archived = false');
      // MAIL-02: a Gmail message may carry several labels while the legacy row retains one primary folder. The
      // membership table makes it visible in every projected folder, but only for rows that actually have that
      // membership; IMAP rows and provider rows before migration 0116 retain the old `m.folder` behaviour.
      whereConditions.push(messageFolderMembershipSql({ accountIdParam: 1 }, folderParam));
      displayFolderExpr = `(CASE WHEN m.folder = $${folderParam} THEN m.folder ELSE $${folderParam} END)`;
    }
  } else {
    whereConditions.push(`m.account_id = ANY($${p++})`);
    values.push(scopedAccountIds);
    whereConditions.push('m.is_archived = false');
    whereConditions.push(messageFolderMembershipSql({ accountIdsParam: 1 }));
    displayFolderExpr = "'INBOX'";
  }

  const isUnreadOnly = unreadOnly === 'true' || unreadOnly === true;
  if (isUnreadOnly) whereConditions.push('m.is_read = false');

  // Category filter: 'primary' matches NULL and 'primary'; others match exactly.
  const safeCategory = typeof category === 'string' && category.length > 0 ? category : null;
  if (safeCategory && safeCategory !== 'primary') {
    whereConditions.push(`m.category = $${p++}`);
    values.push(safeCategory);
  } else if (safeCategory === 'primary') {
    whereConditions.push(`(m.category IS NULL OR m.category = 'primary')`);
  }

  // #407: hide UID-only placeholder rows whose envelope has not been fetched yet. During a
  // rapid archive/reconcile overlap a UID can be listed before its envelope arrives, rendering
  // as an "Unknown / (no subject)" ghost row. A genuine message always carries at least a
  // Message-ID, a real subject, or a snippet, so this predicate only ever hides the hollow
  // placeholder, never a real message. Applies to both the flat and threaded queries (shared
  // `where`), so pagination and the threaded count stay consistent.
  whereConditions.push(populatedMessageSql);

  const where = whereConditions.join(' AND ');

  const safeLimit  = Math.min(Math.max(Number(limit)  || 50, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  const isThreaded = threaded === 'true' || threaded === true;
  let total: number | null = null;
  if (!isThreaded) {
    // The cached folder counters count only the legacy primary `folder`, while the membership predicate above can
    // add a message to another projected label. Count from the same predicate so pagination and the returned total
    // describe the same set (MAIL-02); this is intentionally scoped to the query, not a destructive rewrite of the
    // existing counters.
    const countValues = [...values];
    const r = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM messages m WHERE ${where}`,
      countValues,
    );
    total = r.rows[0]?.n ?? 0;
  }

  if (isThreaded) {
    const filterValues = [...values];
    const threadAccountParam = isSpecificAccount ? [resolvedAccountId] : scopedAccountIds;
    // thread_key is a stored generated column and is covered by the threaded-list
    // indexes. Historical blank thread ids are normalized by migration 0141, so
    // the hot path can use the indexed column directly instead of recalculating a
    // trimming/COALESCE expression for every row in GROUP BY and joins.
    const effectiveThreadExpr = `m.thread_key`;
    const threadIdentityExpr = isSpecificAccount
      ? effectiveThreadExpr
      : `(m.account_id::text || ':' || ${effectiveThreadExpr})`;
    // Expansion and its badge count physical messages across all folders. RFC
    // Message-ID is a conversation hint, never proof of provider object identity.
    // Filtered unread_count still describes this folder/category/unread view.
    const threadResult = await query(`
      WITH paged_threads AS (
        SELECT m.account_id, ${effectiveThreadExpr} AS thread_bucket
        FROM messages m
        WHERE ${where}
        GROUP BY m.account_id, ${effectiveThreadExpr}
        ORDER BY MAX(m.date) DESC, m.account_id, thread_bucket
        LIMIT $${p + 1} OFFSET $${p + 2}
      ),
      physical_messages AS MATERIALIZED (
        SELECT m.id, m.uid, ${displayFolderExpr} AS folder, m.message_id,
               ${threadIdentityExpr} AS thread_id,
               m.thread_key,
               m.subject, m.from_name, m.from_email,
               m.to_addresses, m.cc_addresses, m.draft_bcc_addresses, m.draft_uid_validity::text AS draft_uid_validity, m.draft_alias_id, m.draft_in_reply_to, m.draft_references, m.draft_composition, m.reply_to, m.in_reply_to,
               m.date, m.snippet, m.is_read, m.is_starred,
               m.has_attachments, m.account_id, m.category,
               m.spam_verdict, m.spam_score_ml, m.spam_score_blended,
               m.list_unsubscribe, m.list_unsubscribe_post, m.delivery_addresses,
               a.name  AS account_name,
               a.email_address AS account_email,
               a.color AS account_color,
               (EXISTS (
                  SELECT 1 FROM contacts photo_contact
                   WHERE photo_contact.user_id = a.user_id
                     AND photo_contact.primary_email = lower(m.from_email)
                     AND photo_contact.photo_data IS NOT NULL
                )) AS has_contact_photo
        FROM messages m
        JOIN paged_threads pt ON pt.account_id = m.account_id AND pt.thread_bucket = ${effectiveThreadExpr}
        JOIN email_accounts a ON m.account_id = a.id

        WHERE ${where}
      ),
      thread_totals AS (
        SELECT ${threadIdentityExpr} AS thread_id,
               COUNT(*)::int AS message_count
        FROM messages m
        JOIN paged_threads pt ON pt.account_id = m.account_id AND pt.thread_bucket = ${effectiveThreadExpr}
        WHERE m.account_id = ANY($${p})
          AND m.is_deleted = false
          AND ${visiblePhysicalMessageSql}
          AND ${populatedMessageSql}
        GROUP BY ${threadIdentityExpr}
      ),
      ranked AS (
        SELECT d.*,
               COALESCE(tt.message_count, 1) AS message_count,
               COUNT(*) FILTER (WHERE NOT d.is_read) OVER (PARTITION BY d.thread_id)::int AS unread_count,
               FIRST_VALUE(d.subject)           OVER (PARTITION BY d.thread_id ORDER BY d.date ASC, d.id ASC) AS thread_subject,
               FIRST_VALUE(d.from_name)          OVER (PARTITION BY d.thread_id ORDER BY d.date ASC, d.id ASC) AS thread_from_name,
               FIRST_VALUE(d.from_email)         OVER (PARTITION BY d.thread_id ORDER BY d.date ASC, d.id ASC) AS thread_from_email,
               FIRST_VALUE(d.has_contact_photo)  OVER (PARTITION BY d.thread_id ORDER BY d.date ASC, d.id ASC) AS thread_has_contact_photo,
               -- Latest message direction: the parent row shows the direction of the
               -- most recent physical child, not the thread's first message. ORDER BY date DESC
               -- picks the newest; the tie-breaker (id) keeps it deterministic when two
               -- children share the same timestamp.
               FIRST_VALUE(d.from_email) OVER (PARTITION BY d.thread_id ORDER BY d.date DESC, d.id DESC) AS latest_from_email,
               FIRST_VALUE(d.from_name)  OVER (PARTITION BY d.thread_id ORDER BY d.date DESC, d.id DESC) AS latest_from_name,
               ROW_NUMBER() OVER (PARTITION BY d.thread_id ORDER BY d.date DESC NULLS LAST, d.id DESC) AS rn
        FROM physical_messages d
        LEFT JOIN thread_totals tt ON tt.thread_id = d.thread_id
      )
      SELECT id, uid, folder, message_id, thread_id, thread_key, thread_subject AS subject,
             thread_from_name AS from_name, thread_from_email AS from_email,
             to_addresses, cc_addresses, draft_bcc_addresses, draft_uid_validity, draft_alias_id, draft_in_reply_to, draft_references, draft_composition, reply_to, in_reply_to,
             date, snippet, is_starred, is_read AS physical_is_read, (unread_count = 0) AS is_read, has_attachments, account_id,
             account_name, account_email, account_color,
             category, spam_verdict, spam_score_ml, spam_score_blended, list_unsubscribe, list_unsubscribe_post, delivery_addresses,
             message_count, unread_count,
             thread_has_contact_photo AS has_contact_photo,
             latest_from_email, latest_from_name
      FROM ranked
      WHERE rn = 1
      ORDER BY date DESC NULLS LAST, id DESC
    `, [...filterValues, threadAccountParam, safeLimit, safeOffset]);

    const threadCountResult = await query(`
      SELECT COUNT(*)::int AS total
      FROM (
        SELECT m.account_id, ${effectiveThreadExpr} AS thread_bucket
        FROM messages m
        WHERE ${where}
        GROUP BY m.account_id, ${effectiveThreadExpr}
      ) counted_threads
    `, filterValues);

    return {
      messages: threadResult.rows,
      total: threadCountResult.rows[0]?.total ?? 0,
      threaded: true,
      resolvedAccountId,
    };
  }

  const limitParam  = p;
  const offsetParam = p + 1;
  values.push(safeLimit, safeOffset);

  // Select the page before fetching wide message metadata or contact photos.
  // Label membership must not make a 50-row view hydrate an entire inbox.
  const result = await query(`
    WITH page_messages AS MATERIALIZED (
      SELECT m.id
      FROM messages m
      WHERE ${where}
      ORDER BY m.date DESC NULLS LAST, m.id DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    )
    SELECT m.id, m.uid, ${displayFolderExpr} AS folder, m.message_id, m.thread_id, m.thread_key, m.subject, m.from_name, m.from_email,
           m.to_addresses, m.cc_addresses, m.draft_bcc_addresses, m.draft_uid_validity::text AS draft_uid_validity, m.draft_alias_id, m.draft_in_reply_to, m.draft_references, m.draft_composition, m.reply_to, m.in_reply_to,
           m.date, m.snippet, m.is_read, m.is_starred,
           m.has_attachments, m.account_id, m.category,
           m.spam_verdict, m.spam_score_ml, m.spam_score_blended,
           m.list_unsubscribe, m.list_unsubscribe_post, m.delivery_addresses,
           a.name as account_name, a.email_address as account_email, a.color as account_color,
           (EXISTS (
                  SELECT 1 FROM contacts photo_contact
                   WHERE photo_contact.user_id = a.user_id
                     AND photo_contact.primary_email = lower(m.from_email)
                     AND photo_contact.photo_data IS NOT NULL
                )) AS has_contact_photo
    FROM page_messages page
    JOIN messages m ON m.id = page.id
    JOIN email_accounts a ON m.account_id = a.id
    ORDER BY m.date DESC NULLS LAST, m.id DESC
  `, values);

  return {
    messages: result.rows,
    total: total ?? 0,
    resolvedAccountId,
  };
}
