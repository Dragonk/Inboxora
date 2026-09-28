import { api } from './api.ts';
import type { ComposeDraft } from '../store/index.ts';

export interface ScheduledAttachment { filename: string; content: string; contentType?: string }
export interface ScheduledMessage {
  accountId: string; aliasId?: string | null; to: string[]; cc?: string[]; bcc?: string[];
  subject: string; body: string; bodyIsHtml: boolean; quotedBody?: string; quotedBodyHtml?: string | null;
  editedSignature?: string | null; editedSignatureIsHtml?: boolean;
  attachments?: ScheduledAttachment[];
  forwardedAttachments?: Array<{ messageId: string; part: string; filename?: string }>;
  priority?: 'high' | 'normal' | 'low'; sendKind?: 'new' | 'reply' | 'reply_all' | 'forward';
  inReplyTo?: string | null; references?: string | null; replyToMessageId?: string | null;
  replyParentMessageId?: string | null; replyParentAccountId?: string | null;
}
export type ScheduledState = 'pending' | 'editing' | 'preparing' | 'sending' | 'sent' | 'partial' | 'failed' | 'uncertain' | 'cancelled';
export interface ScheduledSummary {
  id: string; accountId: string; subject: string; mode: 'undo' | 'schedule'; state: ScheduledState;
  scheduledAt: string; timeZone: string; revision: number; errorCode: string | null;
}
export interface ScheduleSelection { scheduledAt: string; timeZone: string }
export interface ScheduledEdit extends ScheduleSelection { id: string; revision: number; state: 'editing'; message: ScheduledMessage }
export interface ScheduledEnqueue { message: ScheduledMessage; mode: 'undo' | 'schedule'; timeZone: string; scheduledAt?: string }
const path = (id: string) => `/mail/scheduled/${encodeURIComponent(id)}`;
export const scheduledApi = {
  list: (signal?: AbortSignal): Promise<ScheduledSummary[]> => api.get('/mail/scheduled', { signal }),
  enqueue: (body: ScheduledEnqueue, key: string): Promise<ScheduledSummary> => api.post('/mail/scheduled', body, { 'X-Idempotency-Key': key }),
  edit: (id: string, revision: number): Promise<ScheduledEdit> => api.post(`${path(id)}/edit`, { revision }),
  update: (id: string, body: ScheduleSelection & { revision: number; message: ScheduledMessage }): Promise<ScheduledSummary> => api.put(path(id), body),
  reschedule: (id: string, body: ScheduleSelection & { revision: number }): Promise<ScheduledSummary> => api.patch(path(id), body),
  cancel: (id: string, revision: number): Promise<ScheduledSummary> => api.post(`${path(id)}/cancel`, { revision }),
};
export function scheduledEditToDraft(edit: ScheduledEdit): ComposeDraft {
  return { ...edit.message, aliasId: edit.message.aliasId ?? null, queuedMail: { id: edit.id, revision: edit.revision, scheduledAt: edit.scheduledAt, timeZone: edit.timeZone },
    queuedRetryRecipients: true, isReply: edit.message.sendKind === 'reply' || edit.message.sendKind === 'reply_all',
    isReplyAll: edit.message.sendKind === 'reply_all', isForward: edit.message.sendKind === 'forward' };
}
