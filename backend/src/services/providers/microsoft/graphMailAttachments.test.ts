import { describe, it, expect, vi, beforeEach } from 'vitest';

// The two Graph numbers decide a METHOD, not a limit: 3 MB is where an attachment stops travelling in
// the create call, 150 MB is the largest file an upload session takes, and neither is a message limit.
// These cases pin that separation and the chunk protocol around it.
const tokenMock = vi.hoisted(() => vi.fn(async () => ({
  accessToken: 'graph-token-1', expiresAt: new Date(Date.now() + 3600_000), generation: 1, refreshed: false, scopes: [],
})));
vi.mock('../../providerTokenService.js', () => ({ getMicrosoftAccessToken: tokenMock }));

import {
  GRAPH_DIRECT_ATTACHMENT_MAX_BYTES,
  GRAPH_UPLOAD_CHUNK_ALIGNMENT,
  GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES,
  GraphAttachmentTooLargeError,
  GraphUploadSessionExpiredError,
  addGraphAttachment,
  chooseAttachmentStrategy,
  nextOffsetFromRanges,
  uploadAttachmentChunks,
} from './graphMailAttachments.js';
import { GraphApiError } from './graphApiClient.js';

const api = (fetchImpl: unknown) => ({ userId: 'user-1', connectionId: 'connection-1', config: { clientId: 'x' }, fetchImpl } as never);
const attachment = (size: number) => ({
  filename: 'file.bin', content: Buffer.alloc(size, 1), contentType: 'application/octet-stream',
});

beforeEach(() => tokenMock.mockClear());

describe('choosing the attachment method', () => {
  it('treats 3 MB as the method threshold and 150 MB as the upload-session file ceiling', () => {
    expect(chooseAttachmentStrategy(GRAPH_DIRECT_ATTACHMENT_MAX_BYTES)).toBe('direct');
    expect(chooseAttachmentStrategy(GRAPH_DIRECT_ATTACHMENT_MAX_BYTES + 1)).toBe('upload_session');
    expect(chooseAttachmentStrategy(GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES)).toBe('upload_session');
    expect(chooseAttachmentStrategy(GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES + 1)).toBe('too_large');
  });
});

describe('a small attachment', () => {
  it('travels in the create call, and refuses when the provider returns no id', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'att-1' }), { status: 201, headers: { 'content-type': 'application/json' } }));
    const result = await addGraphAttachment(api(fetchImpl), 'draft-1', attachment(1024));

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/me/messages/draft-1/attachments');
    expect(url).not.toContain('createUploadSession');
    const sent = JSON.parse(String(init.body)) as { '@odata.type': string; contentBytes: string; name: string };
    expect(sent['@odata.type']).toBe('#microsoft.graph.fileAttachment');
    expect(sent.name).toBe('file.bin');
    expect(sent.contentBytes).toBe(Buffer.alloc(1024, 1).toString('base64'));
    expect(result).toEqual({ id: 'att-1', strategy: 'direct' });
  });

  it('refuses a file above the upload-session ceiling without calling the provider', async () => {
    const fetchImpl = vi.fn();
    await expect(addGraphAttachment(api(fetchImpl), 'draft-1', attachment(GRAPH_UPLOAD_SESSION_FILE_MAX_BYTES + 1)))
      .rejects.toBeInstanceOf(GraphAttachmentTooLargeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('a large attachment', () => {
  const session = { uploadUrl: 'https://upload.example.test/session-1', expirationDateTime: '2026-01-01T00:00:00Z' };

  it('opens a session and sends aligned chunks without an Authorization header', async () => {
    const draftFetch = vi.fn(async () => new Response(JSON.stringify(session), { status: 200, headers: { 'content-type': 'application/json' } }));
    const uploadFetch = vi.fn(async () => new Response(JSON.stringify({ id: 'att-big' }), { status: 201, headers: { 'content-type': 'application/json' } }));

    const size = GRAPH_DIRECT_ATTACHMENT_MAX_BYTES + GRAPH_UPLOAD_CHUNK_ALIGNMENT;
    const result = await addGraphAttachment(api(draftFetch), 'draft-1', attachment(size), { fetchImpl: uploadFetch as never });

    const [sessionUrl, sessionInit] = draftFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(sessionUrl).toContain('/attachments/createUploadSession');
    const item = (JSON.parse(String(sessionInit.body)) as { AttachmentItem: { size: number; attachmentType: string } }).AttachmentItem;
    expect(item).toEqual(expect.objectContaining({ attachmentType: 'file', size }));

    const [, uploadInit] = uploadFetch.mock.calls[0] as unknown as [string, RequestInit];
    const headers = uploadInit.headers as Record<string, string>;
    // The pre-authorized URL carries its own authorization; sending one is a documented rejection.
    expect(headers.authorization).toBeUndefined();
    expect(headers['content-range']).toMatch(/^bytes 0-\d+\/\d+$/);
    const [, end] = /^bytes 0-(\d+)\//.exec(headers['content-range'])!;
    expect(Number(end) + 1).toBe(GRAPH_UPLOAD_CHUNK_ALIGNMENT * 4);
    expect(result).toEqual({ id: 'att-big', strategy: 'upload_session' });
  });

  it('resumes from nextExpectedRanges instead of assuming the chunk landed', async () => {
    const content = Buffer.alloc(GRAPH_UPLOAD_CHUNK_ALIGNMENT * 6, 7);
    const uploadFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ nextExpectedRanges: [`${GRAPH_UPLOAD_CHUNK_ALIGNMENT * 4}-`] }), { status: 202, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'att-big' }), { status: 201, headers: { 'content-type': 'application/json' } }));
    await uploadAttachmentChunks({ uploadUrl: 'https://upload.example.test/s' }, content, uploadFetch as never);

    const second = (uploadFetch.mock.calls[1] as unknown as [string, RequestInit])[1].headers as unknown as Record<string, string>;
    expect(second['content-range']).toMatch(new RegExp(`^bytes ${GRAPH_UPLOAD_CHUNK_ALIGNMENT * 4}-`));
  });

  it('reports an expired session as expired rather than restarting it', async () => {
    const uploadFetch = vi.fn(async () => new Response(null, { status: 410 }));
    await expect(uploadAttachmentChunks({ uploadUrl: 'https://upload.example.test/s' }, Buffer.alloc(1024), uploadFetch as never))
      .rejects.toBeInstanceOf(GraphUploadSessionExpiredError);
    expect(uploadFetch).toHaveBeenCalledTimes(1);
  });

  it('classifies a provider refusal on a chunk', async () => {
    const uploadFetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'ErrorAccessDenied', message: 'no' } }), { status: 403, headers: { 'content-type': 'application/json' } }));
    await expect(uploadAttachmentChunks({ uploadUrl: 'https://upload.example.test/s' }, Buffer.alloc(1024), uploadFetch as never))
      .rejects.toBeInstanceOf(GraphApiError);
  });

  it('parses the resume offset defensively', () => {
    expect(nextOffsetFromRanges(['327680-'], 0)).toBe(327680);
    expect(nextOffsetFromRanges([], 99)).toBe(99);
    expect(nextOffsetFromRanges('nonsense', 99)).toBe(99);
  });
});
