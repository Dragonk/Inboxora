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
export type ScheduledState = 'pending' | 'editing' | 'preparing' | 'sending' | 'sent' | 'partial' | 'failed' | 'uncertain' | 'cancelled' | 'dismissed';
/** Explicit keys keep the complete state vocabulary checked by the translation gate. */
export const scheduledStateLabels: Record<ScheduledState, string> = {
  pending: 'queue.states.pending', editing: 'queue.states.editing', preparing: 'queue.states.preparing',
  sending: 'queue.states.sending', sent: 'queue.states.sent', partial: 'queue.states.partial',
  failed: 'queue.states.failed', uncertain: 'queue.states.uncertain', cancelled: 'queue.states.cancelled', dismissed: 'queue.states.dismissed',
};
export interface ScheduledSummary {
  id: string; accountId: string; subject: string; mode: 'undo' | 'schedule'; state: ScheduledState;
  scheduledAt: string; timeZone: string; revision: number; errorCode: string | null;
  senderEmail?: string | null; to?: string[]; cc?: string[]; recipientCount?: number;
}
export interface ScheduleSelection { scheduledAt: string; timeZone: string }
export interface ScheduledEdit extends ScheduleSelection { id: string; revision: number; state: 'editing'; message: ScheduledMessage }
export interface ScheduledEnqueue { message: ScheduledMessage; mode: 'undo' | 'schedule'; timeZone: string; scheduledAt?: string }
/** Encode a queue identity as one API path segment. */
const path = (id: string) => `/mail/scheduled/${encodeURIComponent(id)}`;
/** Queue API with revision guards; only an explicit edit returns message contents. */
export interface ScheduledPage { items: ScheduledSummary[]; nextCursor: string | null }
export interface ScheduledSource {
  id: string; accountId: string; subject: string | null; fromName: string | null; fromEmail: string | null;
  date: string | null; snippet: string | null;
}
export type ScheduledPreviewMessage = Omit<ScheduledMessage, 'attachments' | 'forwardedAttachments'> & {
  attachments: Array<{ filename: string; contentType?: string; size: number }>;
};
export interface ScheduledPreview {
  id: string; state: ScheduledState; senderEmail?: string | null; message: ScheduledPreviewMessage | null;
  context: ScheduledSource[]; contextMissing: boolean; sentCopy: ScheduledSource | null;
}
export const scheduledApi = {
  page: async (signal?: AbortSignal, cursor?: string): Promise<ScheduledPage> => {
    const result: ScheduledPage | ScheduledSummary[] = await api.get(`/mail/scheduled?page=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal });
    // Older clients/servers can coexist briefly during a paired container update.
    return Array.isArray(result) ? { items: result, nextCursor: null } : result;
  },
  preview: (id: string, signal?: AbortSignal): Promise<ScheduledPreview> => api.get(`/mail/scheduled/${encodeURIComponent(id)}`, { signal }),
  seen: (id: string): Promise<{ id: string }> => api.post(`/mail/scheduled/${encodeURIComponent(id)}/seen`, {}),
  /** Read owner-visible metadata, abortable when the authenticated view closes. */
  list: (signal?: AbortSignal): Promise<ScheduledSummary[]> => api.get('/mail/scheduled', { signal }),
  /** Replay the same immutable request and idempotency key after an uncertain acknowledgement. */
  enqueue: (body: ScheduledEnqueue, key: string): Promise<ScheduledSummary> => api.post('/mail/scheduled', body, { 'X-Idempotency-Key': key }),
  /** Atomically pause a retryable entry and return its editable snapshot. */
  edit: (id: string, revision: number): Promise<ScheduledEdit> => api.post(`${path(id)}/edit`, { revision }),
  /** Persist an exact paused snapshot at the supplied revision. */
  update: (id: string, body: ScheduleSelection & { revision: number; message: ScheduledMessage }): Promise<ScheduledSummary> => api.put(path(id), body),
  /** Resume a paused or waiting entry using its current revision. */
  reschedule: (id: string, body: ScheduleSelection & { revision: number }): Promise<ScheduledSummary> => api.patch(path(id), body),
  /** Cancel a retryable entry and remove its stored contents. */
  cancel: (id: string, revision: number): Promise<ScheduledSummary> => api.post(`${path(id)}/cancel`, { revision }),
  /** Remove uncertain delivery contents without recalling or retrying delivery; old-revision replay is idempotent. */
  dismiss: (id: string, revision: number): Promise<ScheduledSummary> => api.post(`${path(id)}/dismiss`, { revision }),
};
/** Restore the server-approved retry snapshot without expanding its recipient set. */
export function scheduledEditToDraft(edit: ScheduledEdit): ComposeDraft {
  return { ...edit.message, aliasId: edit.message.aliasId ?? null, queuedMail: { id: edit.id, revision: edit.revision, scheduledAt: edit.scheduledAt, timeZone: edit.timeZone },
    queuedRetryRecipients: true, isReply: edit.message.sendKind === 'reply' || edit.message.sendKind === 'reply_all',
    isReplyAll: edit.message.sendKind === 'reply_all', isForward: edit.message.sendKind === 'forward' };
}
