import sanitizeHtml from 'sanitize-html';
import { executeSend, type PreparedSend, type SendRequestBody } from '../services/sendMail.js';
import { McpError } from './policy.js';

export type MailSignatureMode = 'configured' | 'override' | 'none';
export interface MailApprovalEdit {
  to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; bodyIsHtml: boolean; bodyChanged: boolean;
  signature: string; signatureIsHtml: boolean; signatureChanged: boolean;
  priority?: 'high' | 'normal' | 'low';
  keepAttachmentIndexes?: number[];
  newAttachments?: Array<{ filename: string; content: string; contentType?: string }>;
}

function plainMailText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {}, nonTextTags: ['script','style','textarea','option'] });
}

export function mailReviewFromPrepared(prepared: PreparedSend, signatureMode: MailSignatureMode = 'configured'): Record<string, unknown> {
  const payload = prepared.payload;
  const signature = payload.editedSignature ?? '';
  return {
    kind: 'mail',
    senderName: prepared.senderName ?? null, senderEmail: prepared.senderEmail, accountId: payload.accountId ?? null, aliasId: payload.aliasId ?? null,
    to: payload.to ?? [], cc: payload.cc ?? [], bcc: payload.bcc ?? [], subject: payload.subject ?? '', priority: payload.priority ?? 'normal',
    bodyText: payload.bodyIsHtml ? plainMailText(payload.body) : payload.body ?? '',
    bodyHtml: payload.bodyIsHtml ? payload.body ?? '' : '', bodyIsHtml: payload.bodyIsHtml === true,
    signatureMode, signatureText: payload.editedSignatureIsHtml ? plainMailText(signature) : signature,
    signatureHtml: payload.editedSignatureIsHtml ? signature : '', signatureIsHtml: payload.editedSignatureIsHtml === true,
    quotedText: payload.quotedBody ?? plainMailText(payload.quotedBodyHtml), quotedHtml: payload.quotedBodyHtml ?? '',
    attachments: payload.attachments?.map((item, index) => ({ index, filename: item.filename, bytes: Buffer.byteLength(item.content, 'base64'), contentType: item.contentType ?? null })) ?? [],
  };
}

export async function reprepareEditedMail(userId: string, existing: PreparedSend & { review?: Record<string, unknown> }, edit: MailApprovalEdit) {
  const existingMode = existing.review?.signatureMode;
  const signatureMode: MailSignatureMode = edit.signatureChanged ? (edit.signature ? 'override' : 'none')
    : existingMode === 'override' || existingMode === 'none' ? existingMode : 'configured';
  const currentAttachments = existing.payload.attachments ?? [];
  const keepIndexes = edit.keepAttachmentIndexes ?? currentAttachments.map((_item, index) => index);
  const uniqueKeep = [...new Set(keepIndexes)];
  if (uniqueKeep.some(index => !Number.isInteger(index) || index < 0 || index >= currentAttachments.length)) {
    throw new McpError('ATTACHMENT_SELECTION_INVALID', 'One of the selected attachments is no longer available.', 409);
  }
  const payload: SendRequestBody = {
    ...existing.payload, to: edit.to, cc: edit.cc, bcc: edit.bcc, subject: edit.subject, priority: edit.priority ?? existing.payload.priority ?? 'normal',
    ...(edit.bodyChanged ? { body: edit.body, bodyIsHtml: edit.bodyIsHtml } : {}),
    ...(edit.signatureChanged ? { editedSignature: edit.signature, editedSignatureIsHtml: edit.signatureIsHtml } : {}),
    attachments: [...uniqueKeep.map(index => currentAttachments[index]), ...(edit.newAttachments ?? [])],
  };
  const result = await executeSend(userId, payload, null, { prepareOnly: true, expectedSenderEmail: existing.senderEmail,
    expectedSenderName: existing.senderName ?? undefined });
  if (!result.prepared || result.status !== 200) throw new McpError(String(result.body.code || 'COMPOSE_INVALID'), String(result.body.error || 'Message cannot be prepared.'), result.status >= 400 ? result.status : 400);
  return { ...result.prepared, review: mailReviewFromPrepared(result.prepared, signatureMode) };
}
