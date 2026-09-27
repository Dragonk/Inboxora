import { query } from './db.js';
import { extractHtmlTextForRules } from './messageParser.js';
import { sanitizeEmail } from './emailSanitizer.js';
import type { EmailAccountRow } from './imapManager.js';
import type { MailActionPort } from './mailActionPort.js';

/** A body condition is a demanded feature read, not speculative warming. Do not
 * enable bulk BODY[] fetches or fall back to IMAP for native provider accounts. */
export async function hydrateRequiredImapRuleBody(input: {
  messageId: string; accountId: string; userId: string; uid: string | number; folder: string; read: MailActionPort['fetchMessageBody'];
}): Promise<string | undefined> {
  const result = await query<EmailAccountRow & {
    uid: string | number; folder: string; row_version: string | number;
    body_text: string | null; body_html: string | null;
  }>(`SELECT a.*, m.uid, m.folder, m.row_version, m.body_text, m.body_html
      FROM messages m JOIN email_accounts a ON a.id=m.account_id
     WHERE m.id=$1 AND a.id=$2 AND a.user_id=$3 AND a.enabled=true AND m.is_deleted=false
       AND (a.mail_transport IS NULL OR a.mail_transport='imap_smtp')
       AND m.uid=$4 AND m.folder=$5`,
  [input.messageId,input.accountId,input.userId,input.uid,input.folder]);
  const row = result.rows[0];
  if (!row) return undefined;
  if (row.body_text !== null) return row.body_text;
  let html = row.body_html;
  let text: string | null = null;
  let attachments: unknown[] | null = null;
  if (!html) {
    const fetched = await input.read(row,row.uid,row.folder);
    // An unavailable/empty fetch is unknown, not evidence for a not_contains rule.
    if (!fetched.text && !fetched.html) return undefined;
    html = fetched.html ? sanitizeEmail(fetched.html) : null;
    text = fetched.text ?? null;
    if (Array.isArray(fetched.attachments)) attachments = fetched.attachments;
  }
  if (!text && html) {
    // The text extractor has a finite budget. Do not evaluate a negative body
    // condition from a potentially truncated HTML-only message.
    if (Buffer.byteLength(html) > 1_048_576) return undefined;
    text = extractHtmlTextForRules(html);
  }
  if (text === null) return undefined;
  text = text.replace(/\0/g,'');
  html = html?.replace(/\0/g,'') ?? null;
  const saved = await query<{ body_text: string }>(`UPDATE messages m
       SET body_text=COALESCE(m.body_text,$1), body_html=COALESCE(m.body_html,$2),
           attachments=CASE WHEN jsonb_array_length(COALESCE($3::jsonb,'[]'::jsonb)) > 0
             THEN $3::jsonb ELSE m.attachments END
      FROM email_accounts a
     WHERE m.id=$4 AND m.account_id=a.id AND a.id=$5 AND a.user_id=$6 AND a.enabled=true
       AND (a.mail_transport IS NULL OR a.mail_transport='imap_smtp')
       AND m.row_version=$7 AND m.uid=$8 AND m.folder=$9 AND m.is_deleted=false
       AND m.body_html IS NOT DISTINCT FROM $10::text
     RETURNING m.body_text`,
  [text,html,attachments ? JSON.stringify(attachments) : null,input.messageId,input.accountId,input.userId,
    row.row_version,row.uid,row.folder,row.body_html]);
  return saved.rows[0]?.body_text;
}
