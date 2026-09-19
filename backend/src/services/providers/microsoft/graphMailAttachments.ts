import { GRAPH_API_BASE, classifyGraphError, graphPost, type GraphApiOptions } from './graphApiClient.js';
import type { ComposedAttachment } from '../../composedMail.js';

/**
 * The two Graph attachment numbers, kept apart from every message-size limit because they are not one.
 *
 * `3 MB` is the threshold above which Graph stops accepting an attachment inline in the create call and
 * requires an upload session — a choice of *method*, not a ceiling. `150 MB` is the largest single file an
 * upload session accepts. Neither of them is a limit on the message, and neither may be used as one.
 */
export const GRAPH_DIRECT_ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;
export const GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES = 150 * 1024 * 1024;
/** Graph requires every chunk except the last to be a multiple of 320 KiB. */
export const GRAPH_UPLOAD_CHUNK_ALIGNMENT = 320 * 1024;
const CHUNK_BYTES = GRAPH_UPLOAD_CHUNK_ALIGNMENT * 4;
const MAX_CHUNK_ATTEMPTS = 3;

export type GraphAttachmentStrategy = 'direct' | 'upload_session' | 'too_large';

export class GraphUploadSessionExpiredError extends Error {
  constructor() {
    super('The Microsoft Graph upload session has expired');
    this.name = 'GraphUploadSessionExpiredError';
  }
}

export class GraphAttachmentTooLargeError extends Error {
  constructor(readonly sizeBytes: number) {
    super(`The attachment is ${sizeBytes} bytes, above the ${GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES}-byte upload-session file limit`);
    this.name = 'GraphAttachmentTooLargeError';
  }
}

/** Which route one attachment takes. Pure, so the policy is testable without a provider. */
export function chooseAttachmentStrategy(sizeBytes: number): GraphAttachmentStrategy {
  if (sizeBytes <= GRAPH_DIRECT_ATTACHMENT_MAX_BYTES) return 'direct';
  if (sizeBytes <= GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES) return 'upload_session';
  return 'too_large';
}

export interface GraphUploadSession {
  uploadUrl: string;
  expirationDateTime?: string | null;
}

export interface GraphAttachmentResult {
  id: string;
  strategy: Exclude<GraphAttachmentStrategy, 'too_large'>;
}

type FetchLike = typeof fetch;

/**
 * Add one attachment to the draft, choosing the method by size.
 *
 * A file at or below the direct threshold is attached in the message body; a larger one becomes an upload
 * session whose chunks are sent to the pre-authorized URL. That URL carries its own authorization, which
 * is why no `Authorization` header is sent with it — sending one is a documented way to have the upload
 * rejected.
 */
export async function addGraphAttachment(
  api: GraphApiOptions,
  draftId: string,
  attachment: ComposedAttachment,
  options: { fetchImpl?: FetchLike } = {},
): Promise<GraphAttachmentResult> {
  const strategy = chooseAttachmentStrategy(attachment.content.length);
  if (strategy === 'too_large') throw new GraphAttachmentTooLargeError(attachment.content.length);

  if (strategy === 'direct') {
    const created = await graphPost<{ id?: string }>(api, `/me/messages/${encodeURIComponent(draftId)}/attachments`, {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: attachment.filename,
      contentType: attachment.contentType ?? 'application/octet-stream',
      contentBytes: attachment.content.toString('base64'),
    });
    if (!created?.id) throw new Error('Microsoft Graph did not return an attachment id');
    return { id: created.id, strategy };
  }

  const session = await createGraphUploadSession(api, draftId, attachment);
  const uploaded = await uploadAttachmentChunks(session, attachment.content, options.fetchImpl ?? fetch);
  return { id: uploaded.id, strategy };
}

/** Open an upload session for a large attachment. */
export async function createGraphUploadSession(
  api: GraphApiOptions,
  draftId: string,
  attachment: ComposedAttachment,
): Promise<GraphUploadSession> {
  const session = await graphPost<GraphUploadSession>(
    api,
    `/me/messages/${encodeURIComponent(draftId)}/attachments/createUploadSession`,
    {
      AttachmentItem: {
        attachmentType: 'file',
        name: attachment.filename,
        size: attachment.content.length,
        contentType: attachment.contentType ?? 'application/octet-stream',
      },
    },
  );
  if (!session?.uploadUrl) throw new Error('Microsoft Graph did not return an upload URL');
  return session;
}

/** Parse Graph's `nextExpectedRanges`; the first range's start is where the next chunk goes. */
export function nextOffsetFromRanges(ranges: unknown, fallbackOffset: number): number {
  if (!Array.isArray(ranges)) return fallbackOffset;
  const first = ranges.find(range => typeof range === 'string');
  if (typeof first !== 'string') return fallbackOffset;
  const match = /^(\d+)/.exec(first);
  return match ? Number(match[1]) : fallbackOffset;
}

/**
 * Send the file in aligned chunks, resuming from whatever the provider says it has.
 *
 * Every chunk is retried only against the session's own state: a `202` carries `nextExpectedRanges`, and
 * the next request starts there rather than assuming the previous chunk landed. A session that has expired
 * is reported as such — re-opening one is a new provider object, which is a decision for the caller and not
 * something a chunk loop should do silently.
 */
export async function uploadAttachmentChunks(
  session: GraphUploadSession,
  content: Buffer,
  fetchImpl: FetchLike,
): Promise<{ id: string }> {
  const total = content.length;
  let offset = 0;
  let attempts = 0;

  while (offset < total) {
    const end = Math.min(offset + CHUNK_BYTES, total) - 1;
    const chunk = content.subarray(offset, end + 1);

    let response: Response;
    try {
      response = await fetchImpl(session.uploadUrl, {
        method: 'PUT',
        // The upload URL is pre-authorized: no Authorization header belongs here.
        headers: {
          'content-length': String(chunk.length),
          'content-range': `bytes ${offset}-${end}/${total}`,
        },
        body: chunk,
      });
    } catch (caught) {
      attempts += 1;
      if (attempts >= MAX_CHUNK_ATTEMPTS) throw caught;
      continue;
    }

    if (response.status === 202) {
      const body = await response.json().catch(() => null) as { nextExpectedRanges?: unknown } | null;
      offset = nextOffsetFromRanges(body?.nextExpectedRanges, end + 1);
      attempts = 0;
      continue;
    }
    if (response.status === 404 || response.status === 410) throw new GraphUploadSessionExpiredError();
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      attempts += 1;
      // 5xx and 429 are the provider's own transient answers; anything else is classified and thrown.
      if ((response.status >= 500 || response.status === 429) && attempts < MAX_CHUNK_ATTEMPTS) continue;
      throw classifyGraphError(response.status, body, response.headers);
    }

    const created = await response.json().catch(() => null) as { id?: string } | null;
    if (!created?.id) throw new Error('Microsoft Graph did not return an attachment id after the upload');
    return { id: created.id };
  }

  throw new Error('The upload session finished without a completed attachment');
}

/** Cancel an upload session, releasing the provider-side staging storage. */
export async function cancelGraphUploadSession(session: GraphUploadSession, fetchImpl: FetchLike = fetch): Promise<void> {
  await fetchImpl(session.uploadUrl, { method: 'DELETE' }).catch(() => undefined);
}

export const GRAPH_ATTACHMENTS_URL = (draftId: string): string =>
  `${GRAPH_API_BASE}/me/messages/${encodeURIComponent(draftId)}/attachments`;
