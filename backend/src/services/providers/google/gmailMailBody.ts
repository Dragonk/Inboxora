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
  /** The value stored as the local `part`: Gmail's attachment id, which is what a download addresses. */
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
  if (disposition.includes('inline')) return true;
  return contentId !== null;
}

/**
 * Every part whose bytes can be downloaded, with the identity a download addresses.
 *
 * A part with no `attachmentId` is not offered: Gmail only omits one for content it
 * inlines into the message itself, and inventing a download address for it would
 * make the attachment route promise bytes it cannot fetch.
 */
export function collectGmailAttachments(message: GmailMessage): GmailAttachmentMeta[] {
  const attachments: GmailAttachmentMeta[] = [];
  const walk = (part: GmailPart | null | undefined): void => {
    if (!part) return;
    const attachmentId = part.body?.attachmentId?.trim();
    const filename = (part.filename ?? '').trim();
    if (attachmentId && filename) {
      const contentId = contentIdOf(part);
      attachments.push({
        part: attachmentId,
        filename,
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

/** Decode a leaf part's inline `data`, when Gmail chose to inline it. */
function decodedPartData(part: GmailPart): string | null {
  const data = part.body?.data;
  if (!data) return null;
  return fromBase64Url(data).toString('utf8');
}

/** The first leaf part of a MIME type, depth-first, in the order Gmail lists them. */
function findPart(part: GmailPart | null | undefined, mimeType: string): GmailPart | null {
  if (!part) return null;
  if ((part.mimeType ?? '').toLowerCase() === mimeType && !(part.parts?.length)) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
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
    html: htmlPart ? decodedPartData(htmlPart) : null,
    text: textPart ? decodedPartData(textPart) : null,
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
