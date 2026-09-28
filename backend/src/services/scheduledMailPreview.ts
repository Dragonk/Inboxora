import { query } from './db.js';
import { requireScheduledId, ScheduledMailError } from './scheduledMail.js';
import type { PreparedSend, SendRequestBody } from './sendMail.js';

interface PreviewRow {
  account_id: string; state: string; payload: Partial<PreparedSend>; result: Record<string, unknown> | null;
}
export interface PreviewSource {
  id: string; accountId: string; subject: string; fromName: string | null; fromEmail: string | null;
  date: Date | null; snippet: string | null; messageId: string | null; references: string | null; inReplyTo: string | null;
}
const SOURCE = `m.id, m.account_id AS "accountId", m.subject, m.from_name AS "fromName", m.from_email AS "fromEmail",
  m.date, m.snippet, m.message_id AS "messageId", m.thread_references AS "references", m.in_reply_to AS "inReplyTo"`;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Read only a unique owned physical/RFC identity. Never fall back to a subject or another mailbox. */
async function replyContext(userId: string, accountId: string, message: SendRequestBody): Promise<PreviewSource[]> {
  const sourceAccount = message.replyParentAccountId || accountId;
  if (!UUID.test(sourceAccount)) return [];
  const physical = typeof message.replyToMessageId === 'string' && UUID.test(message.replyToMessageId) ? message.replyToMessageId : null;
  const rfc = message.replyParentMessageId || message.inReplyTo || null;
  let parents: PreviewSource[] = [];
  if (physical) parents = (await query<PreviewSource>(`SELECT ${SOURCE} FROM messages m
    JOIN email_accounts a ON a.id=m.account_id WHERE m.id=$1 AND m.account_id=$2 AND a.user_id=$3 AND NOT m.is_deleted`,
  [physical, sourceAccount, userId])).rows;
  if (!parents.length && rfc) parents = (await query<PreviewSource>(`SELECT ${SOURCE} FROM messages m
    JOIN email_accounts a ON a.id=m.account_id WHERE m.message_id=$1 AND m.account_id=$2 AND a.user_id=$3 AND NOT m.is_deleted LIMIT 2`,
  [rfc.trim(), sourceAccount, userId])).rows;
  if (parents.length !== 1) return [];
  const parent = parents[0];
  const references = [...new Set(`${parent.references ?? ''} ${parent.inReplyTo ?? ''}`.match(/<[^<>\s]+>/g) ?? [])].slice(-50);
  if (!references.length) return parents;
  const ancestors = (await query<PreviewSource>(`SELECT DISTINCT ON (m.message_id) ${SOURCE} FROM messages m
    JOIN email_accounts a ON a.id=m.account_id WHERE m.account_id=$1 AND a.user_id=$2 AND NOT m.is_deleted
    AND m.message_id=ANY($3::text[]) AND m.id<>$4 ORDER BY m.message_id,m.date DESC,m.id`,
  [sourceAccount, userId, references, parent.id])).rows;
  return [...ancestors, parent].sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
}
/** Resolve the receipt to one actual Sent copy without keeping its body in the queue. */
async function sentCopy(userId: string, row: PreviewRow): Promise<PreviewSource | null> {
  const value = row.result?.sentReference;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const reference = value as Record<string, unknown>;
  const rfc = typeof reference.rfcMessageId === 'string' ? reference.rfcMessageId : null;
  const provider = typeof reference.providerMessageId === 'string' ? reference.providerMessageId : null;
  if (!rfc && !provider) return null;
  const sentFolder = typeof row.result?.sentFolder === 'string' ? row.result.sentFolder : null;
  const rows = (await query<PreviewSource>(`SELECT ${SOURCE} FROM messages m
    JOIN email_accounts a ON a.id=m.account_id WHERE a.user_id=$1 AND m.account_id=$2 AND NOT m.is_deleted
    AND (($3::text IS NOT NULL AND m.message_id=$3) OR ($4::text IS NOT NULL AND m.provider_message_id=$4))
    AND (m.folder=$5 OR m.folder=a.folder_mappings->>'sent' OR EXISTS
      (SELECT 1 FROM folders f WHERE f.account_id=m.account_id AND f.path=m.folder AND f.special_use ILIKE '%sent%'))
    LIMIT 2`, [userId, row.account_id, rfc, provider, sentFolder])).rows;
  return rows.length === 1 ? rows[0] : null;
}
/** Authorized queue preview. It cannot claim, pause, acknowledge or otherwise mutate delivery. */
export async function previewScheduledMail(userId: string, id: string) {
  requireScheduledId(id);
  const row = (await query<PreviewRow>('SELECT account_id,state,payload,result FROM scheduled_mail WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
  if (!row) throw new ScheduledMailError(404, 'SCHEDULE_MISSING', 'Scheduled message is not available');
  const message = row.payload.payload;
  if (!message) return { id, state: row.state, message: null, senderEmail: null, context: [], contextMissing: false,
    sentCopy: row.state === 'sent' ? await sentCopy(userId, row) : null };
  // Omit bytes from the read-only contract; explicit Edit still receives the full frozen payload.
  const { attachments, forwardedAttachments: _forwarded, ...fields } = message;
  const context = await replyContext(userId, row.account_id, message);
  return { id, state: row.state, senderEmail: row.payload.senderEmail, sentCopy: null,
    message: { ...fields, attachments: (attachments ?? []).map(attachment => ({
      filename: attachment.filename, contentType: attachment.contentType,
      size: Buffer.byteLength(attachment.content, 'base64'),
    })) }, context,
    contextMissing: !context.length && Boolean(message.replyToMessageId || message.inReplyTo || message.replyParentMessageId) };
}
