import { GMAIL_USER, fromBase64Url, gmailGet } from './gmailApi.js';
import type { GoogleApiOptions } from './googleApiClient.js';
import { GMAIL_METADATA_HEADERS, fetchGmailMessage } from './gmailMail.js';
import type { GmailMessage, GmailPart } from './gmailMail.js';

/**
 * Gmail message **body and attachments** (P08, third slice).
 *
 * The reading half of the Gmail adapter: the body is fetched on demand and cached in
 * the same `body_html`/`body_text`/`attachments` columns the IMAP path uses, so the
 * interface needs no branch and the message becomes openable. The provider's own
 * identifiers are carried through — Gmail's per-message **attachment id** is the
 * `part` a download addresses, exactly as the attachment id is for a Graph message
 * and the IMAP part number is for a mailbox one.
 *
 * `format=full` is the one call that answers both questions: Gmail returns the MIME
 * tree with each part's headers, its size and the id its bytes are fetched by, so
 * the visible attachment list and the body come from the same read rather than from
 * two calls that could disagree.
 *
 * Inline images are **embedded**, not left as `cid:` references: a body cached with
 * unresolved `cid:` refs would both render broken and be re-fetched on every view by
 * the existing cache-invalidation rule. Embedding is bounded (count and bytes) so a
 * pathological message cannot turn one body request into an unbounded download.
 */

/** One part's attachment identity, as `format=full` reports it. */
export interface GmailAttachmentMeta {
  /** A download reference: Gmail attachment id or a `gmail-part:` reference for inline bytes. */
  part: string;
  filename: string;
  type: string;
  size: number;
  isInline: boolean;
  /** The `Content-ID` an inline part is referenced by, without its angle brackets. */
  contentId: string | null;
}

/** The attachment shape the rest of the application already reads. */
export interface LocalGmailAttachment {
  part: string;
  filename: string;
  type: string;
  size: number;
  encoding: 'base64';
}

/** Inline images are embedded into the HTML; both bounds are deliberate. */
export const MAX_INLINE_IMAGES = 10;
export const MAX_INLINE_IMAGE_BYTES = 1024 * 1024;

function headerValue(part: GmailPart, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const header of part.headers ?? []) {
    if ((header?.name ?? '').trim().toLowerCase() !== wanted) continue;
    return header?.value ?? '';
  }
  return null;
}

/** A `Content-ID` as the `cid:` reference uses it: the angle brackets are not part of it. */
function contentIdOf(part: GmailPart): string | null {
  const raw = headerValue(part, 'Content-ID');
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^</, '').replace(/>$/, '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isInlinePart(part: GmailPart, contentId: string | null): boolean {
  const disposition = (headerValue(part, 'Content-Disposition') ?? '').toLowerCase();
  // An explicit attachment is visible even when a sender supplied a Content-ID.
  if (disposition.includes('attachment')) return false;
  if (disposition.includes('inline')) return true;
  return contentId !== null;
}

const GMAIL_PART_REFERENCE_PREFIX = 'gmail-part:';

function filenameForPart(part: GmailPart): string {
  const explicit = (part.filename ?? '').trim();
  if (explicit) return explicit;
  const disposition = headerValue(part, 'Content-Disposition') ?? '';
  const named = /filename\*?=(?:UTF-8''|"?)([^;"\r\n]+)/i.exec(disposition)?.[1]?.trim();
  if (named) {
    try { return decodeURIComponent(named); } catch { return named; }
  }
  // A nameless attachment is still a file. This is only a presentation name; the
  // provider identity remains the attachment id/part id below.
  return `attachment-${(part.partId ?? 'part').replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

function isAttachmentPart(part: GmailPart): boolean {
  const disposition = (headerValue(part, 'Content-Disposition') ?? '').toLowerCase();
  return disposition.includes('attachment') || Boolean((part.filename ?? '').trim()) || Boolean(contentIdOf(part));
}

function partReference(part: GmailPart): string | null {
  const attachmentId = part.body?.attachmentId?.trim();
  if (attachmentId) return attachmentId;
  // Gmail includes `data` directly for small parts. The part id is a real,
  // re-resolvable address on a later download — unlike a fabricated attachment id.
  if (part.body?.data !== undefined && part.body?.data !== null) return `${GMAIL_PART_REFERENCE_PREFIX}${part.partId ?? 'root'}`;
  return null;
}

/** Every file part whose bytes are available inline or by attachment id. */
export function collectGmailAttachments(message: GmailMessage): GmailAttachmentMeta[] {
  const attachments: GmailAttachmentMeta[] = [];
  const walk = (part: GmailPart | null | undefined): void => {
    if (!part) return;
    const reference = partReference(part);
    if (reference && isAttachmentPart(part)) {
      const contentId = contentIdOf(part);
      attachments.push({
        part: reference,
        filename: filenameForPart(part),
        type: (part.mimeType ?? '').trim() || 'application/octet-stream',
        size: Math.max(0, part.body?.size ?? 0),
        isInline: isInlinePart(part, contentId),
        contentId,
      });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(message.payload);
  return attachments;
}

/**
 * The attachments a person sees in the list. An inline image is part of the body,
 * not a file to download, so it is excluded here — the same distinction the IMAP
 * path draws between `attachments` and `inlineImages`.
 */
export function localAttachmentsForGmail(attachments: readonly GmailAttachmentMeta[]): LocalGmailAttachment[] {
  return attachments
    .filter(attachment => !attachment.isInline)
    .map(attachment => ({
      part: attachment.part,
      filename: attachment.filename,
      type: attachment.type,
      size: attachment.size,
      encoding: 'base64' as const,
    }));
}

function charsetOf(part: GmailPart): string {
  const source = headerValue(part, 'Content-Type') ?? part.mimeType ?? '';
  return /charset\s*=\s*["']?([^;"'\s]+)/i.exec(source)?.[1] ?? 'utf-8';
}

function decodeText(bytes: Buffer, charset: string): string {
  try { return new TextDecoder(charset).decode(bytes); } catch { return bytes.toString('utf8'); }
}

/** Decode inline data, including a deliberately empty body. */
function decodedPartData(part: GmailPart): string | null {
  const data = part.body?.data;
  if (data === undefined || data === null) return null;
  return decodeText(fromBase64Url(data), charsetOf(part));
}

/** A body leaf, not a text file attached before the real message body. */
function isBodyPart(part: GmailPart): boolean {
  const disposition = (headerValue(part, 'Content-Disposition') ?? '').toLowerCase();
  return !disposition.includes('attachment') && !(part.filename ?? '').trim();
}

/** The first body leaf of a MIME type, depth-first, in Gmail's order. */
function findPart(part: GmailPart | null | undefined, mimeType: string): GmailPart | null {
  if (!part) return null;
  if ((part.mimeType ?? '').toLowerCase() === mimeType && !(part.parts?.length) && isBodyPart(part)) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

function findPartById(part: GmailPart | null | undefined, partId: string): GmailPart | null {
  if (!part) return null;
  if ((part.partId ?? 'root') === partId) return part;
  for (const child of part.parts ?? []) {
    const found = findPartById(child, partId);
    if (found) return found;
  }
  return null;
}

const MAX_GMAIL_BODY_PART_BYTES = 10 * 1024 * 1024;

async function textPartData(api: GoogleApiOptions, messageId: string, part: GmailPart): Promise<string | null> {
  const inline = decodedPartData(part);
  if (inline !== null) return inline;
  const attachmentId = part.body?.attachmentId?.trim();
  if (!attachmentId) return null;
  const bytes = await fetchGmailAttachmentBytes(api, messageId, attachmentId, MAX_GMAIL_BODY_PART_BYTES);
  return decodeText(bytes, charsetOf(part));
}

export interface GmailMessageContent {
  html: string | null;
  text: string | null;
  attachments: GmailAttachmentMeta[];
}

/**
 * Read a message's body and attachment list in one `format=full` call.
 *
 * A message whose HTML part Gmail chose not to inline (a large one) is reported as
 * having no HTML rather than as an empty body: the caller keeps whatever it had
 * cached, which is the same rule the IMAP path follows for a transient empty answer.
 */
export async function fetchGmailMessageContent(api: GoogleApiOptions, messageId: string): Promise<GmailMessageContent> {
  const message = await fetchGmailMessage(api, messageId, 'full');
  if (!message) return { html: null, text: null, attachments: [] };
  const htmlPart = findPart(message.payload, 'text/html');
  const textPart = findPart(message.payload, 'text/plain');
  return {
    html: htmlPart ? await textPartData(api, messageId, htmlPart) : null,
    text: textPart ? await textPartData(api, messageId, textPart) : null,
    attachments: collectGmailAttachments(message),
  };
}

/**
 * The base64 bytes of one attachment.
 *
 * Gmail answers with base64url `data` and a declared `size`; the declared size is
 * what the limit is checked against, before the buffer is decoded — the same
 * "refuse above the limit before materialising it" rule the Graph path uses.
 */
export async function fetchGmailAttachmentBytes(
  api: GoogleApiOptions,
  messageId: string,
  attachmentId: string,
  limitBytes: number,
): Promise<Buffer> {
  if (attachmentId.startsWith(GMAIL_PART_REFERENCE_PREFIX)) {
    const partId = attachmentId.slice(GMAIL_PART_REFERENCE_PREFIX.length);
    const message = await fetchGmailMessage(api, messageId, 'full');
    const part = findPartById(message?.payload, partId);
    const data = part?.body?.data;
    if (data === undefined || data === null) return Buffer.alloc(0);
    const bytes = fromBase64Url(data);
    if (bytes.length > limitBytes) {
      throw Object.assign(new Error('ATTACHMENT_TOO_LARGE'), { code: 'ATTACHMENT_TOO_LARGE' });
    }
    return bytes;
  }
  const attachment = await gmailGet<{ size?: number | null; data?: string | null }>(
    api,
    `users/${GMAIL_USER}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
  if (attachment.size !== null && attachment.size !== undefined && attachment.size > limitBytes) {
    throw Object.assign(new Error('ATTACHMENT_TOO_LARGE'), { code: 'ATTACHMENT_TOO_LARGE' });
  }
  if (!attachment.data) return Buffer.alloc(0);
  const bytes = fromBase64Url(attachment.data);
  if (bytes.length > limitBytes) {
    throw Object.assign(new Error('ATTACHMENT_TOO_LARGE'), { code: 'ATTACHMENT_TOO_LARGE' });
  }
  return bytes;
}

export interface InlineImageData {
  contentId: string;
  contentType: string;
  base64: string;
}

/**
 * Replace `cid:` references with the data URI of the inline part.
 *
 * A reference whose bytes are missing is left alone rather than removed: losing an
 * image silently is worse than a broken one a reader can see is broken.
 */
export function embedGmailInlineImages(html: string, inline: readonly InlineImageData[]): string {
  let result = html;
  for (const image of inline) {
    if (!image.contentId || !image.base64) continue;
    const dataUri = `data:${image.contentType || 'application/octet-stream'};base64,${image.base64}`;
    // `cid:` references appear both bare and percent-encoded inside src attributes.
    result = result.split(`cid:${image.contentId}`).join(dataUri);
    result = result.split(`cid:${encodeURIComponent(image.contentId)}`).join(dataUri);
  }
  return result;
}

/**
 * Fetch the inline parts worth embedding, bounded by count and by bytes.
 *
 * The inline parts were already listed by the body read, so this only downloads the
 * bytes: an inline image is served by `messages.attachments.get` exactly like a
 * visible attachment, which is why both share one fetch.
 */
export async function collectGmailInlineImages(
  api: GoogleApiOptions,
  messageId: string,
  attachments: readonly GmailAttachmentMeta[],
  options: { maxImages?: number; maxBytes?: number } = {},
): Promise<InlineImageData[]> {
  const maxImages = options.maxImages ?? MAX_INLINE_IMAGES;
  const maxBytes = options.maxBytes ?? MAX_INLINE_IMAGE_BYTES;
  const collected: InlineImageData[] = [];
  for (const attachment of attachments) {
    if (collected.length >= maxImages) break;
    if (!attachment.isInline || !attachment.contentId) continue;
    if (attachment.size > maxBytes) continue;
    try {
      const bytes = await fetchGmailAttachmentBytes(api, messageId, attachment.part, maxBytes);
      if (bytes.length === 0) continue;
      collected.push({
        contentId: attachment.contentId,
        contentType: attachment.type,
        base64: bytes.toString('base64'),
      });
    } catch (error) {
      // A single unreadable inline image must not fail the whole body.
      console.warn(`Gmail inline image skipped (${attachment.part}):`, error instanceof Error ? error.message : error);
    }
  }
  return collected;
}

/**
 * The message's real RFC headers, as Gmail returns them.
 *
 * Reading them from the provider is the honest answer to "show me the source
 * headers" — better than synthesising them from the local row, and far better than
 * the IMAP attempt the route used to make for a native account, which could only
 * time out before falling back.
 */
export async function fetchGmailMessageHeaders(api: GoogleApiOptions, messageId: string): Promise<string> {
  const message = await fetchGmailMessage(api, messageId, 'metadata');
  const lines: string[] = [];
  for (const header of message?.payload?.headers ?? []) {
    const name = header?.name?.trim();
    if (!name) continue;
    // A header value may contain folded whitespace; keep it on one line as the parser
    // the route uses expects.
    lines.push(`${name}: ${(header.value ?? '').replace(/\s+/g, ' ').trim()}`);
  }
  return lines.length > 0 ? `${lines.join('\r\n')}\r\n` : '';
}

/** The header names a Gmail metadata read asks for; re-exported so a caller need not know. */
export const GMAIL_HEADER_NAMES: readonly string[] = GMAIL_METADATA_HEADERS;
