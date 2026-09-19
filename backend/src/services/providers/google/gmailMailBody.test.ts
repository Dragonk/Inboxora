import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_INLINE_IMAGE_BYTES,
  collectGmailAttachments,
  collectGmailInlineImages,
  embedGmailInlineImages,
  fetchGmailAttachmentBytes,
  fetchGmailMessageContent,
  fetchGmailMessageHeaders,
  localAttachmentsForGmail,
} from './gmailMailBody.js';
import type { GmailMessage } from './gmailMail.js';

const tokenMock = vi.hoisted(() => vi.fn(async () => ({
  accessToken: 'google-token-1', expiresAt: new Date(Date.now() + 3600_000), generation: 1, refreshed: false, scopes: [],
})));

vi.mock('../../providerTokenService.js', () => ({ getGoogleAccessToken: tokenMock }));

const OPTIONS = {
  userId: 'user-1',
  connectionId: 'connection-1',
  config: { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://inboxora.example/cb' },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const base64url = (value: string): string => Buffer.from(value).toString('base64url');

/** A message whose HTML body references one inline image, plus one visible file. */
const MESSAGE: GmailMessage = {
  id: 'm1',
  threadId: 't1',
  labelIds: ['INBOX'],
  payload: {
    mimeType: 'multipart/related',
    parts: [
      {
        partId: '0',
        mimeType: 'multipart/alternative',
        parts: [
          { partId: '0.0', mimeType: 'text/plain', body: { size: 12, data: base64url('Hello there\n') } },
          { partId: '0.1', mimeType: 'text/html', body: { size: 40, data: base64url('<p>Hello <img src="cid:logo@1"></p>') } },
        ],
      },
      {
        partId: '1',
        mimeType: 'image/png',
        filename: 'logo.png',
        headers: [
          { name: 'Content-ID', value: '<logo@1>' },
          { name: 'Content-Disposition', value: 'inline; filename="logo.png"' },
        ],
        body: { attachmentId: 'att-logo', size: 2048 },
      },
      {
        partId: '2',
        mimeType: 'application/pdf',
        filename: 'invoice.pdf',
        body: { attachmentId: 'att-pdf', size: 4096 },
      },
    ],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  tokenMock.mockClear();
});

describe('reading a Gmail message body and its attachments', () => {
  it('finds the body and lists every downloadable part with its attachment id', () => {
    const attachments = collectGmailAttachments(MESSAGE);
    expect(attachments.map(attachment => [attachment.part, attachment.filename])).toEqual([
      ['att-logo', 'logo.png'],
      ['att-pdf', 'invoice.pdf'],
    ]);
    expect(attachments[0]).toMatchObject({ isInline: true, contentId: 'logo@1', type: 'image/png', size: 2048 });
    expect(attachments[1]).toMatchObject({ isInline: false, contentId: null });

    // The visible list excludes the inline image, exactly as the IMAP path draws the
    // distinction between attachments and inlineImages.
    expect(localAttachmentsForGmail(attachments)).toEqual([
      { part: 'att-pdf', filename: 'invoice.pdf', type: 'application/pdf', size: 4096, encoding: 'base64' },
    ]);
  });

  it('does not offer a part Gmail did not give a download id for', () => {
    const message: GmailMessage = {
      id: 'm1',
      payload: { mimeType: 'text/plain', filename: 'note.txt', body: { size: 3, data: base64url('abc') } },
    };
    expect(collectGmailAttachments(message)).toEqual([]);
  });

  it('reads the HTML and text bodies from one full fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(MESSAGE)));
    const content = await fetchGmailMessageContent(OPTIONS, 'm1');
    expect(content.html).toBe('<p>Hello <img src="cid:logo@1"></p>');
    expect(content.text).toBe('Hello there\n');
    expect(content.attachments).toHaveLength(2);
  });

  it('reports no HTML for a large part Gmail declined to inline', async () => {
    const large: GmailMessage = {
      id: 'm2',
      payload: {
        mimeType: 'multipart/alternative',
        parts: [
          { partId: '0', mimeType: 'text/plain', body: { size: 4, data: base64url('body') } },
          { partId: '1', mimeType: 'text/html', body: { size: 999_999 } },
        ],
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(large)));
    const content = await fetchGmailMessageContent(OPTIONS, 'm2');
    expect(content.html).toBeNull();
    expect(content.text).toBe('body');
  });

  it('replaces a cid reference with the data URI of the inline part', () => {
    const html = '<img src="cid:logo@1"><img src="cid:logo%402">';
    const embedded = embedGmailInlineImages(html, [
      { contentId: 'logo@1', contentType: 'image/png', base64: 'AAAA' },
      { contentId: 'logo@2', contentType: 'image/gif', base64: 'BBBB' },
    ]);
    expect(embedded).toBe('<img src="data:image/png;base64,AAAA"><img src="data:image/gif;base64,BBBB">');
  });

  it('fetches the inline bytes, bounded, and leaves a missing image alone', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes('att-logo')) return jsonResponse({ size: 4, data: base64url('PNG!') });
      return jsonResponse({ size: 0 });
    }));

    const inline = await collectGmailInlineImages(OPTIONS, 'm1', collectGmailAttachments(MESSAGE));
    expect(urls[0]).toContain('/messages/m1/attachments/att-logo');
    expect(inline).toEqual([{ contentId: 'logo@1', contentType: 'image/png', base64: Buffer.from('PNG!').toString('base64') }]);
  });

  it('refuses an attachment the provider declares above the limit before decoding it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ size: 9_000_000, data: base64url('x') })));
    await expect(fetchGmailAttachmentBytes(OPTIONS, 'm1', 'att-big', 1024))
      .rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' });
  });

  it('decodes an attachment back to its bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ size: 5, data: base64url('bytes') })));
    expect((await fetchGmailAttachmentBytes(OPTIONS, 'm1', 'att-pdf', 1024)).toString('utf8')).toBe('bytes');
  });

  it('keeps the byte ceiling that bounds inline embedding', async () => {
    const oversized = [{ part: 'att-huge', filename: 'huge.png', type: 'image/png', size: MAX_INLINE_IMAGE_BYTES + 1, isInline: true, contentId: 'huge' }];
    const fetchMock = vi.fn(async () => jsonResponse({ size: 10, data: base64url('x') }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await collectGmailInlineImages(OPTIONS, 'm1', oversized)).toEqual([]);
    // Refused before any download: the declared size was already over the budget.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the source headers from the provider and folds them onto one line each', async () => {
    const message: GmailMessage = {
      id: 'm1',
      payload: {
        headers: [
          { name: 'Subject', value: 'Report' },
          { name: 'X-Long', value: 'first\n  second' },
          { name: '', value: 'ignored' },
        ],
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(message)));
    expect(await fetchGmailMessageHeaders(OPTIONS, 'm1')).toBe('Subject: Report\r\nX-Long: first second\r\n');
  });
});
