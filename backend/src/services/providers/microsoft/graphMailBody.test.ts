import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectGraphInlineImages,
  embedGraphInlineImages,
  fetchGraphAttachmentBytes,
  fetchGraphAttachments,
  fetchGraphMessageBody,
  fetchGraphMessageHeaders,
  localAttachmentsForGraph,
} from './graphMailBody.js';
import type { GraphAttachment } from './graphMailBody.js';

const tokenMock = vi.hoisted(() => vi.fn(async () => ({
  accessToken: 'graph-token-1', expiresAt: new Date(Date.now() + 3600_000), generation: 1, refreshed: false, scopes: [],
})));

vi.mock('../../providerTokenService.js', () => ({ getMicrosoftAccessToken: tokenMock }));
vi.mock('../../providerAuthService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../providerAuthService.js')>()),
  microsoftConfigFromEnv: () => ({ clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://x/cb', tenantId: 'common' }),
}));

const OPTIONS = { userId: 'user-1', connectionId: 'connection-1' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  tokenMock.mockClear();
});

describe('the attachment list a person sees', () => {
  const attachments: GraphAttachment[] = [
    { id: 'att-1', name: 'plan.pdf', contentType: 'application/pdf', size: 1024 },
    { id: 'att-2', name: 'logo.png', contentType: 'image/png', size: 40, isInline: true, contentId: 'logo@contoso' },
    { id: 'att-3' },
  ];

  it('carries the provider id as the part, and drops inline images from the file list', () => {
    expect(localAttachmentsForGraph(attachments)).toEqual([
      { part: 'att-1', filename: 'plan.pdf', type: 'application/pdf', size: 1024, encoding: 'base64' },
      { part: 'att-3', filename: 'attachment', type: 'application/octet-stream', size: 0, encoding: 'base64' },
    ]);
  });

  it('ignores an attachment Graph returned without an id', () => {
    expect(localAttachmentsForGraph([{ name: 'no id' }])).toEqual([]);
  });
});

describe('reading the body and attachments from Graph', () => {
  it('returns an HTML body with its content type', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ body: { contentType: 'HTML', content: '<p>Hi</p>' } })));
    await expect(fetchGraphMessageBody(OPTIONS, 'm1')).resolves.toEqual({ contentType: 'html', content: '<p>Hi</p>' });
  });

  it('returns null when the message has no body content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ body: null })));
    await expect(fetchGraphMessageBody(OPTIONS, 'm1')).resolves.toBeNull();
  });

  it('follows the attachment paging link', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return String(url).includes('page=2')
        ? jsonResponse({ value: [{ id: 'att-2', name: 'b' }] })
        : jsonResponse({ value: [{ id: 'att-1', name: 'a' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/attachments?page=2' });
    }));
    await expect(fetchGraphAttachments(OPTIONS, 'm1')).resolves.toEqual([{ id: 'att-1', name: 'a' }, { id: 'att-2', name: 'b' }]);
    expect(urls.some(url => url.includes('select='))).toBe(true);
  });

  it('decodes the base64 bytes of an attachment', async () => {
    const bytes = Buffer.from('hello attachment', 'utf8');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ contentBytes: bytes.toString('base64'), size: bytes.length })));
    const fetched = await fetchGraphAttachmentBytes(OPTIONS, 'm1', 'att-1', 1024);
    expect(fetched.toString('utf8')).toBe('hello attachment');
  });

  it('refuses an attachment above the limit without decoding it', async () => {
    const big = Buffer.alloc(2048, 1).toString('base64');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ contentBytes: big, size: 2048 })));
    await expect(fetchGraphAttachmentBytes(OPTIONS, 'm1', 'att-1', 1024)).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' });
  });
});

describe('embedding inline images', () => {
  it('replaces a cid reference, bare or percent-encoded', () => {
    const html = '<img src="cid:logo@contoso"><img src="cid:logo%40contoso">';
    const embedded = embedGraphInlineImages(html, [{ contentId: 'logo@contoso', contentType: 'image/png', base64: 'AAAA' }]);
    expect(embedded).not.toContain('cid:');
    expect(embedded.match(/data:image\/png;base64,AAAA/g)).toHaveLength(2);
  });

  it('leaves a reference whose bytes are missing alone rather than removing the image', () => {
    const html = '<img src="cid:missing@contoso">';
    expect(embedGraphInlineImages(html, [{ contentId: 'present@contoso', contentType: 'image/png', base64: 'AAAA' }])).toBe(html);
  });

  it('fetches only the inline parts, within the bounds', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return jsonResponse({ contentBytes: Buffer.from('img', 'utf8').toString('base64') });
    }));
    const attachments: GraphAttachment[] = [
      { id: 'inline-1', name: 'a.png', contentType: 'image/png', isInline: true, contentId: 'a@x', size: 3 },
      { id: 'inline-2', name: 'big.png', contentType: 'image/png', isInline: true, contentId: 'b@x', size: 5_000_000 },
      { id: 'file-1', name: 'plan.pdf', contentType: 'application/pdf' },
    ];
    const inline = await collectGraphInlineImages(OPTIONS, 'm1', attachments, { maxBytes: 1024 });
    expect(inline).toEqual([{ contentId: 'a@x', contentType: 'image/png', base64: Buffer.from('img', 'utf8').toString('base64') }]);
    // The oversized inline part is skipped before any request for its bytes.
    expect(urls.filter(url => url.includes('inline-2'))).toHaveLength(0);
    expect(urls.filter(url => url.includes('file-1'))).toHaveLength(0);
  });

  it('skips a failed inline image instead of failing the whole body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'ErrorItemNotFound', message: 'gone' } }, 404)));
    await expect(collectGraphInlineImages(OPTIONS, 'm1', [{ id: 'inline-1', isInline: true, contentId: 'a@x' }]))
      .resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('reading the real headers from Graph', () => {
  it('formats the retained RFC headers as the parser expects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      internetMessageHeaders: [
        { name: 'Received', value: 'from contoso.test\r\n\tby mx.contoso.test' },
        { name: 'Subject', value: 'Quarterly plan' },
        { name: '', value: 'ignored' },
      ],
    })));

    const headers = await fetchGraphMessageHeaders(OPTIONS, 'm1');
    // Folded whitespace is collapsed: the route's parser expects one line per header.
    expect(headers).toBe('Received: from contoso.test by mx.contoso.test\r\nSubject: Quarterly plan\r\n');
  });

  it('answers empty rather than inventing headers, because a mailbox may not retain them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ internetMessageHeaders: null })));
    await expect(fetchGraphMessageHeaders(OPTIONS, 'm1')).resolves.toBe('');
  });
});
