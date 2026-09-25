import { graphGet, graphUrl } from './graphApiClient.js';
import type { GraphApiOptions } from './graphApiClient.js';

/**
 * Microsoft Graph message body and attachments (P07b, fourth slice).
 *
 * The reading half of the Graph adapter: the body is fetched on demand and cached
 * in the same `body_html`/`body_text`/`attachments` columns the IMAP path uses, so
 * the interface needs no branch and the message becomes openable. The provider's
 * own identifiers are carried through — the Graph attachment id is the `part` a
 * download addresses, exactly as the IMAP part number is for a mailbox message.
 *
 * Inline images are **embedded**, not left as `cid:` references: Graph gives an
 * inline attachment a `contentId`, and a body cached with unresolved `cid:` refs
 * would both render broken and be re-fetched on every view by the existing
 * cache-invalidation rule. Embedding is bounded (count and bytes) so a pathological
 * message cannot turn one body request into an unbounded download.
 */

export interface GraphAttachment {
  /** Absent is possible in a malformed provider answer, and is handled rather than assumed away. */
  id?: string | null;
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
  isInline?: boolean | null;
  contentId?: string | null;
}

/** The attachment shape the rest of the application already reads. */
export interface LocalGraphAttachment {
  part: string;
  filename: string;
  type: string;
  size: number;
  encoding: 'base64';
}

export interface GraphMessageBody {
  contentType: string;
  content: string;
}

interface GraphAttachmentPage {
  value?: GraphAttachment[];
}

export const GRAPH_ATTACHMENT_SELECT = 'id,name,contentType,size,isInline,contentId';
/** Inline images are embedded into the HTML; both bounds are deliberate. */
export const MAX_INLINE_IMAGES = 10;
export const MAX_INLINE_IMAGE_BYTES = 1024 * 1024;

/** The provider's attachments, paged. */
export async function fetchGraphAttachments(api: GraphApiOptions, providerMessageId: string): Promise<GraphAttachment[]> {
  const attachments: GraphAttachment[] = [];
  let nextLink: string | null = null;
  for (let page = 0; page < 20; page++) {
    const fetched: GraphAttachmentPage = nextLink
      ? await graphGet<GraphAttachmentPage>(api, nextLink)
      : await graphGet<GraphAttachmentPage>(api, graphUrl(
        `/me/messages/${encodeURIComponent(providerMessageId)}/attachments`,
        { $select: GRAPH_ATTACHMENT_SELECT, $top: 100 },
      ));
    for (const attachment of fetched.value ?? []) if (attachment.id) attachments.push(attachment);
    nextLink = (fetched as { '@odata.nextLink'?: string })['@odata.nextLink'] ?? null;
    if (!nextLink) break;
  }
  return attachments;
}

/**
 * The attachments a person sees in the list. An inline image is part of the body,
 * not a file to download, so it is excluded here — the same distinction the IMAP
 * path draws between `attachments` and `inlineImages`.
 */
export function localAttachmentsForGraph(attachments: readonly GraphAttachment[]): LocalGraphAttachment[] {
  const visible: LocalGraphAttachment[] = [];
  for (const attachment of attachments) {
    if (!attachment.id || attachment.isInline) continue;
    visible.push({
      part: attachment.id,
      filename: attachment.name?.trim() || 'attachment',
      type: attachment.contentType?.trim() || 'application/octet-stream',
      size: Math.max(0, attachment.size ?? 0),
      encoding: 'base64',
    });
  }
  return visible;
}

/** The message body as Graph returns it. */
export async function fetchGraphMessageBody(api: GraphApiOptions, providerMessageId: string): Promise<GraphMessageBody | null> {
  const message = await graphGet<{ body?: { contentType?: string | null; content?: string | null } | null }>(
    api,
    graphUrl(`/me/messages/${encodeURIComponent(providerMessageId)}`, { $select: 'body' }),
  );
  const body = message.body;
  if (!body?.content) return null;
  return { contentType: (body.contentType ?? 'text').toLowerCase(), content: body.content };
}

/** The base64 bytes of one attachment, refused above `limitBytes` before downloading. */
export async function fetchGraphAttachmentBytes(
  api: GraphApiOptions,
  providerMessageId: string,
  attachmentId: string,
  limitBytes: number,
): Promise<Buffer> {
  const attachment = await graphGet<{ contentBytes?: string | null; size?: number | null }>(
    api,
    `/me/messages/${encodeURIComponent(providerMessageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
  if (!attachment.contentBytes) return Buffer.alloc(0);
  // `contentBytes` is base64, so the decoded size is what the limit is about.
  const decodedLength = Math.floor((attachment.contentBytes.length * 3) / 4);
  if (decodedLength > limitBytes) {
    throw Object.assign(new Error('ATTACHMENT_TOO_LARGE'), { code: 'ATTACHMENT_TOO_LARGE' });
  }
  return Buffer.from(attachment.contentBytes, 'base64');
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
export function embedGraphInlineImages(html: string, inline: readonly InlineImageData[]): string {
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

/** Fetch the inline parts worth embedding, bounded by count and by bytes. */
export async function collectGraphInlineImages(
  api: GraphApiOptions,
  providerMessageId: string,
  attachments: readonly GraphAttachment[],
  options: { maxImages?: number; maxBytes?: number } = {},
): Promise<InlineImageData[]> {
  const maxImages = options.maxImages ?? MAX_INLINE_IMAGES;
  const maxBytes = options.maxBytes ?? MAX_INLINE_IMAGE_BYTES;
  const collected: InlineImageData[] = [];
  for (const attachment of attachments) {
    if (collected.length >= maxImages) break;
    if (!attachment.isInline || !attachment.contentId || !attachment.id) continue;
    if ((attachment.size ?? 0) > maxBytes) continue;
    try {
      const bytes = await fetchGraphAttachmentBytes(api, providerMessageId, attachment.id, maxBytes);
      if (bytes.length === 0) continue;
      collected.push({
        contentId: attachment.contentId,
        contentType: attachment.contentType?.trim() || 'application/octet-stream',
        base64: bytes.toString('base64'),
      });
    } catch (error) {
      // A single unreadable inline image must not fail the whole body.
      console.warn(`Graph inline image skipped (${attachment.id}):`, error instanceof Error ? error.message : error);
    }
  }
  return collected;
}

export interface GraphInternetHeader {
  name?: string | null;
  value?: string | null;
}

/**
 * The message's real RFC headers, as Graph retains them.
 *
 * Graph exposes these through `internetMessageHeaders`, which is the honest answer
 * to "show me the source headers" — better than synthesising them from the local
 * row, and far better than the IMAP attempt the route used to make for a native
 * account, which could only time out before falling back.
 *
 * `internetMessageHeaders` is **not** returned by every mailbox (it is absent for
 * messages Graph has not indexed them for), so an empty result is a normal answer
 * and the caller keeps its own fallback.
 */
export async function fetchGraphMessageHeaders(api: GraphApiOptions, providerMessageId: string): Promise<string> {
  const message = await graphGet<{ internetMessageHeaders?: GraphInternetHeader[] | null }>(
    api,
    graphUrl(`/me/messages/${encodeURIComponent(providerMessageId)}`, { $select: 'internetMessageHeaders' }),
  );
  const lines: string[] = [];
  for (const header of message.internetMessageHeaders ?? []) {
    const name = header?.name?.trim();
    if (!name) continue;
    // A header value may contain folded whitespace; keep it on one line as the
    // parser the route uses expects.
    lines.push(`${name}: ${(header.value ?? '').replace(/\s+/g, ' ').trim()}`);
  }
  return lines.length > 0 ? `${lines.join('\r\n')}\r\n` : '';
}
