// Shared list of physical-copy columns that must survive a DELETE + reinsert
// (UIDPLUS relocate) or an IMAP COPY sibling insert. Keeping this in a leaf
// module avoids a circular import between routes/mail.js (which imports the
// ImapManager instance via index.js) and services/imapManager.js (which would
// otherwise need to import the list from routes/mail.js).
//
// IMPORTANT: when a migration adds a data column to `messages`, add it here
// or a relocate will silently reset it to its default. This list previously
// went stale and dropped delivery_addresses (0037), plugin_annotations (0044)
// and sender_name/sender_email (0050). A unit test (mail.relocate.test.js)
// guards the columns that regression touched plus all CE v2 columns.
//
// Excluded on purpose:
//   - id, synced_at        -> use their column defaults (a fresh UUID and timestamp)
//   - normalized_subject,
//     search_vector,
//     thread_key           -> GENERATED ALWAYS columns; Postgres computes them
//   - row_version          -> CAS/version safety — a new physical row gets a fresh
//                             lifecycle, not the old row's version

export const RELOCATE_COPY_COLS = [
  'message_id', 'subject', 'from_name', 'from_email', 'to_addresses', 'cc_addresses',
  'reply_to', 'in_reply_to', 'date', 'snippet', 'is_read', 'is_starred', 'has_attachments',
  'flags', 'body_html', 'body_text', 'attachments', 'thread_references', 'thread_id', 'is_bulk',
  'read_changed_at', 'star_changed_at', 'spam_score_sa', 'spam_score_ml', 'spam_verdict',
  'spam_analyzed_at', 'spam_details', 'spam_user_override', 'category', 'list_unsubscribe',
  'list_unsubscribe_post', 'unsubscribed_at', 'delivery_addresses', 'plugin_annotations',
  'sender_name', 'sender_email',
  // Conversation Engine v2 columns — preserved on relocate so identity (LogicalMessage,
  // conversation, canonical Message-ID, provider IDs, threading evidence) survives
  // archive/move/trash/folder rename/resync. Without these, a relocate silently severs
  // the physical copy from its conversation, corrupting the 1:N copy model.
  // conversation_user_id MUST be copied together with conversation_id: a composite FK
  // (fk_message_conversation_owner) and CHECK constraint require both or neither,
  // so copying conversation_id alone would violate chk_message_conversation_owner_present.
  'logical_message_id', 'conversation_id', 'conversation_user_id', 'canonical_message_id',
  'provider_message_id', 'provider_thread_id', 'provider_namespace',
  'threading_reason', 'threading_confidence', 'threading_algorithm_version',
  'conversation_raw_headers', 'conversation_thread_index', 'conversation_thread_topic',
  'automated_series_mode',
];

// INSERT target list and the matching SELECT projection for the UIDPLUS
// DELETE + reinsert CTE. account_id + the carried columns come from the
// deleted row; uid is the UIDPLUS-mapped new uid; folder is the destination ($4).
export const RELOCATE_INSERT_COLS = ['account_id', 'uid', 'folder', ...RELOCATE_COPY_COLS].join(', ');
export const RELOCATE_SELECT_COLS = ['d.account_id', 'u.new_uid', '$4', ...RELOCATE_COPY_COLS.map(c => `d.${c}`)].join(', ');
