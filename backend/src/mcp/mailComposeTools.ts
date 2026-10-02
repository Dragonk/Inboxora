import { fetchSourceAttachment } from '../services/sourceAttachments.js';
import { imapManager } from '../index.js';
import { resolveAllDraftsPaths, type FolderMappings } from '../utils/mailUtils.js';
import { z } from 'zod';
import { query } from '../services/db.js';
import { executeSend, type SendRequestBody } from '../services/sendMail.js';
import { resolveSenderIdentity } from '../services/senderIdentity.js';
import type { EmailAccountRow } from '../services/imapManager.js';
import { scanAttachment } from '../services/attachments/scan.js';
import { domainRequest, domainRead } from './bridge.js';
import { liveGrant, McpError, requireAccount, requireFolder, requireMessage, requireScope, type Grant } from './policy.js';
import { id, records, readTool, writeTool } from './registry.js';
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
  const resolvedAttachments = await materializeAttachments(grant, args);
  return { accountId: args.accountId, aliasId: args.aliasId ?? account.default_alias_id ?? undefined,
    to: args.to, cc: args.cc ?? account.default_cc ?? [], bcc: args.bcc ?? account.default_bcc ?? [],
    subject: args.subject, body: args.body, bodyIsHtml: args.bodyIsHtml, attachments: resolvedAttachments,
    forwardedAttachments: [], priority: args.priority };
}
async function materializeAttachments(grant: Grant, args: Compose) {
  // Resolve referenced content before asking for approval, exactly as send does.
  const attachments = [...args.attachments];
  let totalBytes = attachments.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'base64'), 0);
  for (const reference of args.forwardedAttachments) {
    const source = await requireMessage(grant, reference.messageId);
    const metadata = await domainRead(grant.user_id, `/mail/messages/${reference.messageId}/body`);
    const attachment = records(metadata.attachments).find(item => String(item.part) === reference.part);
    if (!attachment) throw new McpError('ATTACHMENT_UNAVAILABLE', 'A referenced attachment disappeared.', 404);
    const sourceAccount = (await query<EmailAccountRow>('SELECT * FROM email_accounts WHERE id=$1 AND user_id=$2', [source.account_id, grant.user_id])).rows[0];
    const sourceMessage = (await query<{ uid: number; folder: string; provider_message_id: string | null }>('SELECT uid,folder,provider_message_id FROM messages WHERE id=$1 AND account_id=$2', [reference.messageId, source.account_id])).rows[0];
    if (!sourceAccount || !sourceMessage) throw new McpError('ATTACHMENT_UNAVAILABLE', 'The referenced message is unavailable.', 404);
    const filename = typeof attachment.filename === 'string' ? attachment.filename : 'attachment';
    const bytes = await fetchSourceAttachment({ account: sourceAccount, message: sourceMessage, attachment: { part: reference.part, filename }, maxBytes: 1024 * 1024,
      imap: (_account, uid, folder, part) => imapManager.fetchAttachment(sourceAccount, uid, folder, part, 1024 * 1024) });
    totalBytes += bytes.length;
    if (bytes.length > 1024 * 1024 || totalBytes > 3 * 1024 * 1024) throw new McpError('ATTACHMENT_LIMIT', 'MCP attachments exceed their byte budget.', 413);
    await scanAttachment(bytes, AbortSignal.timeout(30000));
    await requireMessage(grant, reference.messageId);
    attachments.push({ filename, content: bytes.toString('base64'), contentType: typeof attachment.type === 'string' ? attachment.type : undefined });
  }
  return attachments;
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
    ...(kind === 'forward' ? {} : { replyToMessageId: args.messageId, replyParentMessageId: typeof metadata.message_id === 'string' ? metadata.message_id : undefined, replyParentAccountId: source.account_id,
      inReplyTo: typeof metadata.message_id === 'string' ? metadata.message_id : undefined,
      references: typeof metadata.thread_references === 'string' ? metadata.thread_references : undefined }) };
}
async function authorizeDraft(grant: Grant, args: Compose & { messageId?: string }): Promise<void> {
  await authorizeCompose(grant, args);
  const account = (await query<{ folder_mappings: FolderMappings | null }>('SELECT folder_mappings FROM email_accounts WHERE id=$1 AND user_id=$2', [args.accountId, grant.user_id])).rows[0];
  if (!account) throw new McpError('RESOURCE_UNAVAILABLE', 'Account not found.', 404);
  const paths = await resolveAllDraftsPaths(args.accountId, account.folder_mappings);
  if (args.messageId) {
    const message = await requireMessage(grant, args.messageId);
    if (message.account_id !== args.accountId || !paths.has(message.folder)) throw new McpError('DRAFT_UNAVAILABLE', 'Only an existing draft in the selected account can be edited.', 404);
  }
  const folder = account.folder_mappings?.drafts ?? (await query<{ path: string }>("SELECT path FROM folders WHERE account_id=$1 AND special_use=$2 ORDER BY path LIMIT 1", [args.accountId, '\\Drafts'])).rows[0]?.path ?? 'Drafts';
  await requireFolder(grant, args.accountId, folder);
}
async function prepareDraft(grant: Grant, args: Compose & { messageId?: string }): Promise<Record<string, unknown>> {
  const payload = await composePayload(grant, args);
  const account = (await query<EmailAccountRow>('SELECT * FROM email_accounts WHERE id=$1 AND user_id=$2', [args.accountId, grant.user_id])).rows[0];
  const sender = await resolveSenderIdentity(account, payload.aliasId);
  if (args.messageId) {
    const existing = (await query<{ draft_composition: Record<string, unknown> | null; draft_in_reply_to: string | null; draft_references: string | null }>(
      'SELECT draft_composition,draft_in_reply_to,draft_references FROM messages WHERE id=$1 AND account_id=$2', [args.messageId,args.accountId])).rows[0];
    if (!existing) throw new McpError('DRAFT_UNAVAILABLE', 'The draft disappeared.', 409);
    const context = existing.draft_composition ?? {};
    // Updating prose must not detach a reply draft from its parent or drop its quote.
    for (const key of ['quotedBody','quotedBodyHtml','replyToMessageId','replyParentMessageId','replyParentAccountId'] as const) {
      if (typeof context[key] === 'string') payload[key] = context[key];
    }
    if (context.replyKind === 'reply' || context.replyKind === 'reply_all') Object.assign(payload, {replyKind:context.replyKind});
    payload.inReplyTo = existing.draft_in_reply_to ?? undefined;
    payload.references = existing.draft_references ?? undefined;
  }
  payload.editedSignature = sender.fromSignature ?? ''; payload.editedSignatureIsHtml = true;
  if (Buffer.byteLength(JSON.stringify(payload)) > 6 * 1024 * 1024) throw new McpError('ATTACHMENT_LIMIT', 'Use Inboxora for drafts larger than 6 MiB.', 413);
  return { payload, review: preparedReview(payload, sender.fromEmail) };
}
async function dispatchDraft(grant: Grant, operationId: string, prepared: Record<string, unknown>, messageId?: string) {
  if (!prepared.payload || typeof prepared.payload !== 'object' || Array.isArray(prepared.payload)) throw new McpError('PREPARATION_INVALID', 'The frozen draft is unavailable.', 409);
  const payload = { ...prepared.payload } as Record<string, unknown>;
  if (messageId) {
    const message = await requireMessage(grant, messageId);
    const row = (await query<{ uid: string | number; draft_uid_validity: string | number | null }>('SELECT uid,draft_uid_validity FROM messages WHERE id=$1 AND account_id=$2', [messageId, message.account_id])).rows[0];
    if (!row) throw new McpError('DRAFT_UNAVAILABLE', 'The draft disappeared.', 409);
    payload.existingDraft = { accountId: message.account_id, uid: row.uid, folder: message.folder, uidValidity: row.draft_uid_validity };
  }
  return domainRequest(grant.user_id, 'POST', '/mail/draft', payload, operationId);
}
export const mailComposeTools = [
  readTool('get_draft', 'Read an existing draft for editing, including its private draft BCC list and authored composition. Requires both mail.read and mail.draft. Preserve the listed recipients and attachments when submitting a replacement.', 'mail.draft', {messageId:id}, async (grant,args) => {
    requireScope(grant,'mail.read');
    const message = await requireMessage(grant,args.messageId);
    const account = (await query<{folder_mappings:FolderMappings|null}>('SELECT folder_mappings FROM email_accounts WHERE id=$1 AND user_id=$2',[message.account_id,grant.user_id])).rows[0];
    const paths = await resolveAllDraftsPaths(message.account_id,account?.folder_mappings);
    if (!paths.has(message.folder)) throw new McpError('DRAFT_UNAVAILABLE','This message is not a draft.',404);
    const body = await domainRead(grant.user_id,`/mail/messages/${args.messageId}/body`);
    await requireMessage(grant,args.messageId);
    const row = (await query(`SELECT subject,to_addresses,cc_addresses,draft_bcc_addresses,draft_alias_id,draft_composition
      FROM messages WHERE id=$1 AND account_id=$2 AND folder=$3`,[args.messageId,message.account_id,message.folder])).rows[0];
    if (!row) throw new McpError('DRAFT_UNAVAILABLE','The draft changed folders.',409);
    const composition = row.draft_composition && typeof row.draft_composition==='object' && !Array.isArray(row.draft_composition) ? row.draft_composition as Record<string,unknown> : {};
    return {draft:{messageId:args.messageId,accountId:message.account_id,aliasId:row.draft_alias_id,
      subject:row.subject,to:row.to_addresses,cc:row.cc_addresses,bcc:row.draft_bcc_addresses,
      body:composition.authoredBody ?? body.text ?? plainMailText(body.html),bodyIsHtml:composition.bodyIsHtml===true,
      attachments:records(body.attachments).map(item=>({messageId:args.messageId,part:item.part,filename:item.filename,type:item.type,size:item.size}))},contentIsUntrusted:true};
  }),
  writeTool('send_email', 'Compose and send a new email through its account provider. Recipients are explicit; omitted CC/BCC and alias use account defaults, shown with the signature in the approval screen. An explicit empty CC/BCC disables that default.', 'mail.send', composeShape,
    authorizeCompose, (grant, _args, operationId, prepared) => dispatchPrepared(grant, operationId, prepared),
    async (grant, args) => prepareMail(grant, await composePayload(grant, args))),
  ...(['reply', 'reply_all', 'forward'] as const).map(kind => writeTool(`${kind}_email`,
    `${kind === 'forward' ? 'Forward an email' : kind === 'reply_all' ? 'Reply to all intended recipients of an email' : 'Reply to an email'}. Supply the exact to/cc/bcc lists after reading the original headers; Inboxora never guesses recipients. Original body, attachments and signature are frozen before approval.`,
    'mail.send', { ...composeShape, messageId: id }, async (grant, args) => { requireScope(grant, 'mail.read'); await requireMessage(grant, args.messageId); await authorizeCompose(grant, args); },
    (grant, _args, operationId, prepared) => dispatchPrepared(grant, operationId, prepared),
    async (grant, args) => prepareMail(grant, await replyPayload(grant, args, kind)))),
  writeTool('create_draft', 'Save a new draft using the account provider, selected/default alias and signature. Does not send. Empty recipient lists are allowed. Forwarded attachments are frozen before approval.', 'mail.draft', composeShape,
    authorizeDraft, (grant, _args, operationId, prepared) => dispatchDraft(grant, operationId, prepared), prepareDraft),
  writeTool('update_draft', 'Replace the editable fields and attachments of an existing draft. Read it first and supply every field to preserve; omitted CC/BCC use account defaults. This never sends the draft.', 'mail.draft', { ...composeShape, messageId: id },
    async (grant, args) => { requireScope(grant, 'mail.read'); await authorizeDraft(grant, args); },
    (grant, args, operationId, prepared) => dispatchDraft(grant, operationId, prepared, args.messageId), prepareDraft),
];
