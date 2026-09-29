import { CSRF_HEADER, CSRF_VALUE } from '../utils/api.ts';

export function queuedAttachmentPath(id: string, revision: number, part: string | undefined): string {
  if (!part || !/^(0|[1-9]\d*)$/.test(part) || !Number.isSafeInteger(Number(part))) throw new Error('Invalid attachment index');
  return `/api/mail/scheduled/${encodeURIComponent(id)}/attachments/${part}?revision=${encodeURIComponent(revision)}`;
}
export function queuedPreviewAttachments(attachments: ReadonlyArray<{ filename: string; contentType?: string; size: number }>) {
  return attachments.map((attachment, index) => ({ filename: attachment.filename, type: attachment.contentType, size: attachment.size, part: String(index) }));
}
/** Authenticated binary read, fenced to the preview/session that requested it. */
export async function downloadMailAttachment(path: string, filename: string | undefined, signal: AbortSignal, isCurrent: () => boolean): Promise<void> {
  if (signal.aborted || !isCurrent()) return;
  const response = await fetch(path, { credentials: 'include', headers: { [CSRF_HEADER]: CSRF_VALUE }, signal });
  if (!response.ok) throw new Error('Attachment download failed');
  const blob = await response.blob();
  if (signal.aborted || !isCurrent()) return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  try {
    anchor.href = url;
    anchor.download = filename || 'attachment';
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}
