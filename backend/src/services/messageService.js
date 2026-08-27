import { query } from './db.js';
import { resolveAccountScope } from './unifiedInbox.js';

export async function listMessages({ userId, accountId, folder = 'INBOX', limit = 50, offset = 0, unreadOnly, threaded, category }) {
  const accountsResult = await query(
    'SELECT id, include_in_unified_inbox FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [userId]
  );
  const {
    accountIds: scopedAccountIds,
    resolvedAccountId,
  } = resolveAccountScope(accountsResult.rows, accountId);
  if (!scopedAccountIds.length) return { messages: [], total: 0 };

  let whereConditions = ['m.is_deleted = false'];
  const values = [];
  let p = 1;

  const isSpecificAccount = resolvedAccountId !== null;

  if (isSpecificAccount) {
    whereConditions.push(`m.account_id = $${p++}`);
    values.push(resolvedAccountId);
    whereConditions.push(`m.folder = $${p++}`);
    values.push(folder);
  } else {
    whereConditions.push(`m.account_id = ANY($${p++})`);
    values.push(scopedAccountIds);
    whereConditions.push(`m.folder = 'INBOX'`);
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
  whereConditions.push(`NOT (m.message_id IS NULL AND (m.subject IS NULL OR m.subject = '(no subject)') AND COALESCE(m.snippet, '') = '')`);

  const where = whereConditions.join(' AND ');

  const safeLimit  = Math.min(Math.max(parseInt(limit)  || 50, 1), 500);
  const safeOffset = Math.max(parseInt(offset) || 0, 0);

  let total = 0;
  try {
    if (isSpecificAccount) {
      const r = await query(
        'SELECT total_count, unread_count FROM folders WHERE account_id = $1 AND path = $2',
        [accountId, folder]
      );
      if (r.rows.length) {
        total = isUnreadOnly ? (r.rows[0].unread_count ?? 0) : (r.rows[0].total_count ?? 0);
      }
    } else {
      const r = isUnreadOnly
        ? await query(
            "SELECT COALESCE(SUM(unread_count), 0)::int AS n FROM folders WHERE account_id = ANY($1) AND path = 'INBOX'",
            [scopedAccountIds]
          )
        : await query(
            "SELECT COALESCE(SUM(total_count), 0)::int AS n FROM folders WHERE account_id = ANY($1) AND path = 'INBOX'",
            [scopedAccountIds]
          );
      total = r.rows[0]?.n ?? 0;
    }
  } catch {
    total = 0;
  }

  if (threaded === 'true' || threaded === true) {
    const filterValues = [...values];
    const threadAccountParam = isSpecificAccount ? [resolvedAccountId] : scopedAccountIds;
    // Legacy thread_key values are only account-local. In unified inboxes, expose a
    // composite row/cache identity while retaining the raw thread_key for expansion.
    const threadIdentityExpr = isSpecificAccount
      ? 'm.thread_key'
      : `(m.account_id::text || ':' || m.thread_key)`;
    // The thread badge must equal the number of unique children the expansion renders.
    // /mail/thread/:threadId loads ALL folders (Inbox + Sent + Archive + duplicates) and
    // deduplicates by message_id, so thread_totals must count across all folders too.
    // Scoping the badge to the current folder produced badge=2 while expansion showed 3
    // (Inbox+Sent+Inbox) — a silent mismatch between the list and the reader.
    const threadFolderFilter = '';

    const threadResult = await query(`
      WITH paged_threads AS (
        SELECT ${threadIdentityExpr} AS thread_id
        FROM messages m
        WHERE ${where}
        GROUP BY ${threadIdentityExpr}
        ORDER BY MAX(m.date) DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
      ),
      deduped AS MATERIALIZED (
        SELECT DISTINCT ON (m.account_id, m.thread_key,
                            COALESCE(NULLIF(btrim(m.message_id), ''), '__physical__:' || m.id::text))
               m.id, m.uid, m.folder, m.message_id,
               ${threadIdentityExpr} AS thread_id,
               m.thread_key,
               m.subject, m.from_name, m.from_email,
               m.to_addresses, m.cc_addresses, m.reply_to, m.in_reply_to,
               m.date, m.snippet, m.is_read, m.is_starred,
               m.has_attachments, m.account_id, m.category,
               m.list_unsubscribe, m.list_unsubscribe_post, m.delivery_addresses,
               a.name  AS account_name,
               a.email_address AS account_email,
               a.color AS account_color,
               (co.id IS NOT NULL) AS has_contact_photo
        FROM messages m
        JOIN email_accounts a ON m.account_id = a.id
        LEFT JOIN contacts co ON co.user_id = a.user_id
                              AND co.primary_email = lower(m.from_email)
                              AND co.photo_data IS NOT NULL
        WHERE ${where}
          AND ${threadIdentityExpr} IN (SELECT thread_id FROM paged_threads)
        ORDER BY m.account_id,
                 m.thread_key,
                 COALESCE(NULLIF(btrim(m.message_id), ''), '__physical__:' || m.id::text),
                 CASE WHEN m.folder = 'INBOX' THEN 0 ELSE 1 END,
                 m.date ASC
      ),
      thread_totals AS (
        SELECT ${threadIdentityExpr} AS thread_id,
               -- Same normalized identity as /mail/thread/:threadId expansion:
               -- valid RFC Message-ID (trimmed) dedupes folder copies; NULL/empty IDs
               -- fall back to their physical message ID so they remain visible/countable.
               COUNT(DISTINCT COALESCE(NULLIF(btrim(m.message_id), ''), '__physical__:' || m.id::text))::int AS message_count
        FROM messages m
        WHERE m.account_id = ANY($${p})
          AND m.is_deleted = false
          AND ${threadIdentityExpr} IN (SELECT thread_id FROM paged_threads)
        GROUP BY ${threadIdentityExpr}
      ),
      ranked AS (
        SELECT d.*,
               COALESCE(tt.message_count, 1) AS message_count,
               COUNT(*) FILTER (WHERE NOT d.is_read) OVER (PARTITION BY d.thread_id)::int AS unread_count,
               FIRST_VALUE(d.subject)           OVER (PARTITION BY d.thread_id ORDER BY d.date ASC) AS thread_subject,
               FIRST_VALUE(d.from_name)          OVER (PARTITION BY d.thread_id ORDER BY d.date ASC) AS thread_from_name,
               FIRST_VALUE(d.from_email)         OVER (PARTITION BY d.thread_id ORDER BY d.date ASC) AS thread_from_email,
               FIRST_VALUE(d.has_contact_photo)  OVER (PARTITION BY d.thread_id ORDER BY d.date ASC) AS thread_has_contact_photo,
               -- Latest message direction: the parent row shows the direction of the
               -- most recent unique child, not the thread's first message. ORDER BY date DESC
               -- picks the newest; the tie-breaker (id) keeps it deterministic when two
               -- children share the same timestamp.
               FIRST_VALUE(d.from_email) OVER (PARTITION BY d.thread_id ORDER BY d.date DESC, d.id DESC) AS latest_from_email,
               FIRST_VALUE(d.from_name)  OVER (PARTITION BY d.thread_id ORDER BY d.date DESC, d.id DESC) AS latest_from_name,
               ROW_NUMBER() OVER (PARTITION BY d.thread_id ORDER BY d.date DESC) AS rn
        FROM deduped d
        LEFT JOIN thread_totals tt ON tt.thread_id = d.thread_id
      )
      SELECT id, uid, folder, message_id, thread_id, thread_key, thread_subject AS subject,
             thread_from_name AS from_name, thread_from_email AS from_email,
             to_addresses, cc_addresses, reply_to, in_reply_to,
             date, snippet, is_starred, is_read, has_attachments, account_id,
             account_name, account_email, account_color,
             category, list_unsubscribe, list_unsubscribe_post, delivery_addresses,
             message_count, unread_count,
             thread_has_contact_photo AS has_contact_photo,
             latest_from_email, latest_from_name
      FROM ranked
      WHERE rn = 1
      ORDER BY date DESC
    `, [...filterValues, threadAccountParam, safeLimit, safeOffset]);

    const threadCountResult = await query(`
      SELECT COUNT(DISTINCT ${threadIdentityExpr})::int AS total
      FROM messages m
      WHERE ${where}
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

  const result = await query(`
    SELECT m.id, m.uid, m.folder, m.message_id, m.thread_id, m.thread_key, m.subject, m.from_name, m.from_email,
           m.to_addresses, m.cc_addresses, m.reply_to, m.in_reply_to,
           m.date, m.snippet, m.is_read, m.is_starred,
           m.has_attachments, m.account_id, m.category,
           m.list_unsubscribe, m.list_unsubscribe_post, m.delivery_addresses,
           a.name as account_name, a.email_address as account_email, a.color as account_color,
           (co.id IS NOT NULL) AS has_contact_photo
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    LEFT JOIN contacts co ON co.user_id = a.user_id
                          AND co.primary_email = lower(m.from_email)
                          AND co.photo_data IS NOT NULL
    WHERE ${where}
    ORDER BY m.date DESC
    LIMIT $${limitParam} OFFSET $${offsetParam}
  `, values);

  return {
    messages: result.rows,
    total,
    resolvedAccountId,
  };
}
