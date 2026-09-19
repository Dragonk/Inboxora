import { afterEach, describe, expect, it, vi } from 'vitest';
import { GRAPH_API_BASE } from './graphApiClient.js';

// The escaping and page-parsing rules are pure, but the module also carries the ingest
// service, which reaches PostgreSQL and the sync. Both are stubbed here so this suite
// never opens a pool: it asserts the query and the page, not persistence.
vi.mock('../../db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('./graphMailSync.js', () => ({
  applyGraphMailMessagesPage: vi.fn(),
  listGraphFolderTargets: vi.fn(),
  persistConversations: vi.fn(),
  syncGraphMailFoldersForAccount: vi.fn(),
}));

const tokenMock = vi.hoisted(() => vi.fn(async () => ({
  accessToken: 'graph-token-1', expiresAt: new Date(Date.now() + 3600_000), generation: 1, refreshed: false, scopes: [],
})));
vi.mock('../../providerTokenService.js', () => ({ getMicrosoftAccessToken: tokenMock }));
vi.mock('../../providerAuthService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../providerAuthService.js')>()),
  microsoftConfigFromEnv: () => ({ clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://x/cb', tenantId: 'common' }),
}));

import {
  GRAPH_SEARCH_MAX_QUERY_LENGTH,
  GRAPH_SEARCH_PAGE_SIZE,
  boundGraphSearchQuery,
  escapeGraphSearchQuery,
  graphMailSearchUrl,
  searchGraphMessagesPage,
} from './graphMailSearch.js';
import { GRAPH_MESSAGE_SELECT } from './graphMail.js';

const OPTIONS = { userId: 'user-1', connectionId: 'connection-1' };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  tokenMock.mockClear();
});

describe('escaping a query for the Graph $search KQL literal', () => {
  it('leaves an ordinary query untouched', () => {
    expect(escapeGraphSearchQuery('quarterly report')).toBe('quarterly report');
  });

  it('escapes a double quote, which would otherwise close the KQL literal early', () => {
    expect(escapeGraphSearchQuery('say "hi"')).toBe('say \\"hi\\"');
  });

  it('escapes the backslash before the quote, so a trailing escape cannot eat the closing quote', () => {
    // A raw `\"` must become `\\\"`: the backslash stays a literal backslash and the
    // quote stays escaped. Escaping in the other order would produce `\\"` and reopen
    // the literal.
    expect(escapeGraphSearchQuery('C:\\path')).toBe('C:\\\\path');
    expect(escapeGraphSearchQuery('a\\"b')).toBe('a\\\\\\"b');
  });

  it('bounds the query so a huge search cannot become a huge request', () => {
    const long = 'x'.repeat(GRAPH_SEARCH_MAX_QUERY_LENGTH + 250);
    expect(boundGraphSearchQuery(long)).toHaveLength(GRAPH_SEARCH_MAX_QUERY_LENGTH);
    expect(boundGraphSearchQuery('  spaced  ')).toBe('spaced');
    expect(boundGraphSearchQuery('   ')).toBe('');
  });
});

describe('building the provider search URL', () => {
  it('asks /me/messages with the message sync select fields, page size and a quoted literal', () => {
    const url = new URL(graphMailSearchUrl('quarterly report'));
    expect(`${url.origin}${url.pathname}`).toBe(`${GRAPH_API_BASE}/me/messages`);
    expect(url.searchParams.get('$search')).toBe('"quarterly report"');
    expect(url.searchParams.get('$select')).toBe(GRAPH_MESSAGE_SELECT);
    expect(url.searchParams.get('$top')).toBe(String(GRAPH_SEARCH_PAGE_SIZE));
  });

  it('carries the escaped query into the literal', () => {
    const raw = 'subject:"quarterly plan"';
    const url = new URL(graphMailSearchUrl(raw));
    expect(url.searchParams.get('$search')).toBe(`"${escapeGraphSearchQuery(raw)}"`);
    expect(url.searchParams.get('$search')).toBe('"subject:\\"quarterly plan\\""');
  });

  it('bounds the query before it is escaped', () => {
    const url = new URL(graphMailSearchUrl('y'.repeat(GRAPH_SEARCH_MAX_QUERY_LENGTH + 50)));
    const literal = url.searchParams.get('$search') ?? '';
    expect(literal).toHaveLength(GRAPH_SEARCH_MAX_QUERY_LENGTH + 2);
  });
});

describe('reading one page of search results', () => {
  it('returns the messages and Graph\'s own continuation verbatim', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return jsonResponse({
        value: [{ id: 'm1', subject: 'Quarterly plan' }, { id: 'm2' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=page2',
      });
    }));

    const page = await searchGraphMessagesPage(OPTIONS, { query: 'quarterly' });
    expect(page.messages.map(message => message.id)).toEqual(['m1', 'm2']);
    expect(page.nextLink).toBe('https://graph.microsoft.com/v1.0/me/messages?$skiptoken=page2');
    expect(urls[0]).toContain('/me/messages');
    expect(urls[0]).toContain('%24search=');
  });

  it('answers with no continuation when Graph omits the next link', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ value: [] })));
    const page = await searchGraphMessagesPage(OPTIONS, { query: 'nothing' });
    expect(page).toEqual({ messages: [], nextLink: null });
  });

  it('resumes from the next link without resending the query', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return jsonResponse({ value: [] });
    }));

    const nextLink = 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=page2';
    await searchGraphMessagesPage(OPTIONS, { query: 'quarterly', nextLink });
    expect(urls).toEqual([nextLink]);
  });

  it('makes no provider call for an empty query', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ value: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(searchGraphMessagesPage(OPTIONS, { query: '   ' })).resolves.toEqual({ messages: [], nextLink: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
