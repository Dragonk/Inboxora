import { z } from 'zod';
import { query } from '../services/db.js';
import { executeSend, type SendRequestBody } from '../services/sendMail.js';
import { resolveSenderIdentity } from '../services/senderIdentity.js';
import type { EmailAccountRow } from '../services/imapManager.js';
import { scanAttachment } from '../services/attachments/scan.js';
import { domainRequest, domainRead } from './bridge.js';
import { liveGrant, McpError, requireAccount, requireMessage, requireScope, type Grant } from './policy.js';
import { id, records, writeTool } from './registry.js';
import { plainMailText } from './mailReadTools.js';

const recipients = z.array(z.string().trim().min(3).max(320)).max(100);
const attachment = z.object({ filename: z.string().min(1).max(255), content: z.string().max(1400000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/), contentType: z.string().max(120).optional() }).strict();
export const composeShape = {
  accountId: id, aliasId: id.optional(), to: recipients, cc: recipients.optional(), bcc: recipients.optional(),
  subject: z.string().max(998).default(''), body: z.string().max(500000), bodyIsHtml: z.boolean().default(false),
  attachments: z.array(attachment).max(10).default([]),
  forwardedAttachments: z.array(z.object({ messageId: id, part: z.string().min(1).max(1024) }).strict()).max(10).default([]),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
};
const _composeSchema = z.object(composeShape);
type Compose = z.output<typeof _composeSchema>;
async function authorizeCompose(grant: Grant, args: Compose): Promise<void> {
  await requireAccount(grant, args.accountId);
  if (args.forwardedAttachments.length) requireScope(grant, 'mail.read');
  for (const source of args.forwardedAttachments) await requireMessage(grant, source.messageId);
  if (args.aliasId) {
    const alias = await query('SELECT id FROM account_aliases WHERE id=$1 AND account_id=$2', [args.aliasId, args.accountId]);
    if (!alias.rows.length) throw new McpError('SENDER_UNAVAILABLE', 'The selected sender alias is unavailable.', 404);
  }
}
async function composePayload(grant: Grant, args: Compose): Promise<SendRequestBody> {
  const account = (await query<EmailAccountRow>('SELECT * FROM email_accounts WHERE id=$1 AND user_id=$2 AND enabled=true', [args.accountId, grant.user_id])).rows[0];
  if (!account) throw new McpError('RESOURCE_UNAVAILABLE', 'Sending account is unavailable.', 404);
  const bytes = args.attachments.map(item => Buffer.from(item.content, 'base64'));
  if (bytes.reduce((sum, value) => sum + value.length, 0) > 3 * 1024 * 1024) throw new McpError('ATTACHMENT_LIMIT', 'MCP uploads are limited to 3 MiB in total.', 413);
  for (const value of bytes) await scanAttachment(value, AbortSignal.timeout(30000));
  for (const source of args.forwardedAttachments) {
    const message = await domainRead(grant.user_id, `/mail/messages/${source.messageId}/body`);
    const meta = records(message.attachments).find(item => String(item.part) === source.part);
    if (!meta || typeof meta.size !== 'number' || meta.size > 1024 * 1024) throw new McpError('ATTACHMENT_LIMIT', 'Forwarded MCP attachments require known sizes up to 1 MiB. Use Inboxora for larger files.', 413);
  }
  return { accountId: args.accountId, aliasId: args.aliasId ?? account.default_alias_id ?? undefined,
    to: args.to, cc: args.cc ?? account.default_cc ?? [], bcc: args.bcc ?? account.default_bcc ?? [],
    subject: args.subject, body: args.body, bodyIsHtml: args.bodyIsHtml, attachments: args.attachments,
    forwardedAttachments: args.forwardedAttachments, priority: args.priority };
}
function preparedReview(payload: SendRequestBody, senderEmail: string): Record<string, unknown> {
  return { senderEmail, to: payload.to ?? [], cc: payload.cc ?? [], bcc: payload.bcc ?? [], subject: payload.subject ?? '',
    body: payload.bodyIsHtml ? plainMailText(payload.body) : payload.body, bodyIsHtml: payload.bodyIsHtml === true,
    signature: payload.editedSignatureIsHtml ? plainMailText(payload.editedSignature) : payload.editedSignature ?? '',
    quotedText: payload.quotedBody ?? plainMailText(payload.quotedBodyHtml),
    attachments: payload.attachments?.map(item => ({ filename: item.filename, bytes: Buffer.byteLength(item.content, 'base64') })) ?? [] };
}
async function prepareMail(grant: Grant, payload: SendRequestBody): Promise<Record<string, unknown>> {
  const result = await executeSend(grant.user_id, payload, null, { prepareOnly: true });
  if (!result.prepared || result.status !== 200) throw new McpError(String(result.body.code || 'COMPOSE_INVALID'), String(result.body.error || 'Message cannot be prepared.'), result.status >= 400 ? result.status : 400);
  if (Buffer.byteLength(JSON.stringify(result.prepared)) > 6 * 1024 * 1024) throw new McpError('ATTACHMENT_LIMIT', 'Prepared MCP messages are limited to 6 MiB. Use Inboxora for larger messages.', 413);
  return { ...result.prepared, review: preparedReview(result.prepared.payload, result.prepared.senderEmail) };
}
async function dispatchPrepared(grant: Grant, operationId: string, prepared: Record<string, unknown>) {
  // This encrypted object was created only by prepareMail; the delivery service revalidates all fields.
  if (!prepared.payload || typeof prepared.payload !== 'object' || Array.isArray(prepared.payload) || typeof prepared.senderEmail !== 'string') throw new McpError('PREPARATION_INVALID', 'The frozen message is unavailable.', 409);
  const payload = prepared.payload as SendRequestBody;
  return executeSend(grant.user_id, payload, `mcp:${operationId}`, { expectedSenderEmail: prepared.senderEmail,
    beforeDispatch: async () => {
      try { const active = await liveGrant(grant.id, grant.user_id, grant.scopes); requireScope(active, 'mail.send'); await requireAccount(active, String(payload.accountId)); return true; }
      catch { return false; }
    } });
}
async function replyPayload(grant: Grant, args: Compose & { messageId: string }, kind: 'reply' | 'reply_all' | 'forward'): Promise<SendRequestBody> {
  const source = await requireMessage(grant, args.messageId);
  const metadata = await domainRead(grant.user_id, `/mail/messages/${args.messageId}`);
  const body = await domainRead(grant.user_id, `/mail/messages/${args.messageId}/body`);
  const quote = typeof body.text === 'string' && body.text ? body.text : plainMailText(body.html);
  if (quote.length > 500000) throw new McpError('MESSAGE_TOO_LARGE', 'The original email is too large to quote safely through MCP. Use Inboxora to review and forward it.', 413);
  const payload = await composePayload(grant, args);
  return { ...payload, sendKind: kind, quotedBody: quote,
    ...(kind === 'forward' ? {} : { replyToMessageId: args.messageId, replyParentMessageId: args.messageId, replyParentAccountId: source.account_id,
      inReplyTo: typeof metadata.message_id === 'string' ? metadata.message_id : undefined,
      references: typeof metadata.thread_references === 'string' ? metadata.thread_references : undefined }) };
}
export const mailComposeTools = [
  writeTool('send_email', 'Compose and send a new email through its account provider. Recipients are explicit; omitted CC/BCC and alias use account defaults, shown with the signature in the approval screen. An explicit empty CC/BCC disables that default.', 'mail.send', composeShape,
    authorizeCompose, (grant, _args, operationId, prepared) => dispatchPrepared(grant, operationId, prepared),
    async (grant, args) => prepareMail(grant, await composePayload(grant, args))),
  ...(['reply', 'reply_all', 'forward'] as const).map(kind => writeTool(`${kind}_email`,
    `${kind === 'forward' ? 'Forward an email' : kind === 'reply_all' ? 'Reply to all intended recipients of an email' : 'Reply to an email'}. Supply the exact to/cc/bcc lists after reading the original headers; Inboxora never guesses recipients. Original body, attachments and signature are frozen before approval.`,
    'mail.send', { ...composeShape, messageId: id }, async (grant, args) => { requireScope(grant, 'mail.read'); await requireMessage(grant, args.messageId); await authorizeCompose(grant, args); },
    (grant, _args, operationId, prepared) => dispatchPrepared(grant, operationId, prepared),
    async (grant, args) => prepareMail(grant, await replyPayload(grant, args, kind)))),
  writeTool('create_draft', 'Save a new draft using the account provider, selected/default alias and signature. Does not send. Empty recipient lists are allowed.', 'mail.draft', composeShape,
    authorizeCompose, (grant, _args, operationId, prepared) => {
      if (!prepared.payload || typeof prepared.payload !== 'object' || Array.isArray(prepared.payload)) throw new McpError('PREPARATION_INVALID', 'The frozen draft is unavailable.', 409);
      return domainRequest(grant.user_id, 'POST', '/mail/draft', prepared.payload as Record<string, unknown>, operationId);
    }, async (grant, args) => {
      const payload = await composePayload(grant, args);
      const account = (await query<EmailAccountRow>('SELECT * FROM email_accounts WHERE id=$1 AND user_id=$2', [args.accountId, grant.user_id])).rows[0];
      const sender = await resolveSenderIdentity(account, payload.aliasId);
      payload.editedSignature = sender.fromSignature ?? ''; payload.editedSignatureIsHtml = true;
      return { payload, review: preparedReview(payload, sender.fromEmail) };
    }),
];
