import type { ComposedAttachment } from './composedMail.js';

const LIMIT = 25 * 1024 * 1024;
/** Decode only the explicit attachment contract, never arbitrary Nodemailer options. */
export function draftAttachments(value: unknown): ComposedAttachment[] {
  if (value === undefined) return [];
  const invalid = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!Array.isArray(value) || value.length > 100) return invalid('attachments must be an array of at most 100 files');
  let total = 0;
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return invalid('Invalid draft attachment');
    const file = item as Record<string, unknown>;
    if (typeof file.filename !== 'string' || !file.filename.trim() || file.filename.length > 255 || /[\r\n\0]/.test(file.filename)) return invalid('Invalid attachment filename');
    if (typeof file.content !== 'string' || file.content.length > Math.ceil(LIMIT / 3) * 4) return invalid('Invalid attachment content');
    const content = Buffer.from(file.content, 'base64');
    if (content.toString('base64') !== file.content) return invalid('Attachment content must be canonical base64');
    total += content.length;
    if (total > LIMIT) throw Object.assign(new Error('Draft attachments exceed 25 MiB'), { status: 413 });
    if (file.contentType !== undefined && (typeof file.contentType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(file.contentType) || file.contentType.length > 120)) return invalid('Invalid attachment content type');
    return { filename: file.filename, content, contentType: typeof file.contentType === 'string' ? file.contentType : 'application/octet-stream', contentDisposition: 'attachment' };
  });
}
