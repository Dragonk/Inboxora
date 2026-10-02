import sanitizeHtml from 'sanitize-html';
import { executeSend, type PreparedSend, type SendRequestBody } from '../services/sendMail.js';
import { McpError } from './policy.js';

export type MailSignatureMode = 'configured' | 'override' | 'none';
export interface MailApprovalEdit {
  to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; bodyIsHtml: boolean; bodyChanged: boolean;
  signature: string; signatureIsHtml: boolean; signatureChanged: boolean;
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
    senderName: prepared.senderName ?? null, senderEmail: prepared.senderEmail,
    to: payload.to ?? [], cc: payload.cc ?? [], bcc: payload.bcc ?? [], subject: payload.subject ?? '', priority: payload.priority ?? 'normal',
    bodyText: payload.bodyIsHtml ? plainMailText(payload.body) : payload.body ?? '',
    bodyHtml: payload.bodyIsHtml ? payload.body ?? '' : '', bodyIsHtml: payload.bodyIsHtml === true,
    signatureMode, signatureText: payload.editedSignatureIsHtml ? plainMailText(signature) : signature,
    signatureHtml: payload.editedSignatureIsHtml ? signature : '', signatureIsHtml: payload.editedSignatureIsHtml === true,
    quotedText: payload.quotedBody ?? plainMailText(payload.quotedBodyHtml),
    attachments: payload.attachments?.map(item => ({ filename: item.filename, bytes: Buffer.byteLength(item.content, 'base64'), contentType: item.contentType ?? null })) ?? [],
  };
}

export async function reprepareEditedMail(userId: string, existing: PreparedSend & { review?: Record<string, unknown> }, edit: MailApprovalEdit) {
  const existingMode = existing.review?.signatureMode;
  const signatureMode: MailSignatureMode = edit.signatureChanged ? (edit.signature ? 'override' : 'none')
    : existingMode === 'override' || existingMode === 'none' ? existingMode : 'configured';
  const payload: SendRequestBody = {
    ...existing.payload, to: edit.to, cc: edit.cc, bcc: edit.bcc, subject: edit.subject,
    ...(edit.bodyChanged ? { body: edit.body, bodyIsHtml: edit.bodyIsHtml } : {}),
    ...(edit.signatureChanged ? { editedSignature: edit.signature, editedSignatureIsHtml: edit.signatureIsHtml } : {}),
  };
  const result = await executeSend(userId, payload, null, { prepareOnly: true, expectedSenderEmail: existing.senderEmail,
    expectedSenderName: existing.senderName ?? undefined });
  if (!result.prepared || result.status !== 200) throw new McpError(String(result.body.code || 'COMPOSE_INVALID'), String(result.body.error || 'Message cannot be prepared.'), result.status >= 400 ? result.status : 400);
  return { ...result.prepared, review: mailReviewFromPrepared(result.prepared, signatureMode) };
}
