import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyGraphError, graphGet, graphUrl, GraphApiError } from './graphApiClient.js';
import { contactUidForGraphContact, defaultGraphContactFolder, discoverGraphContactFolders, fetchContactsPage, graphContactToVCard, normalizeGraphBirthday } from './graphContacts.js';
import type { GraphContact } from './graphContacts.js';

const tokenMock = vi.hoisted(() => vi.fn(async (_input: { skewSeconds?: number } = {}) => ({
  accessToken: 'graph-token-1', expiresAt: new Date(Date.now() + 3600_000), generation: 1, refreshed: false, scopes: [],
})));

vi.mock('../../providerTokenService.js', () => ({ getMicrosoftAccessToken: tokenMock }));
vi.mock('../../providerAuthService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../providerAuthService.js')>()),
  microsoftConfigFromEnv: () => ({ clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://x/cb', tenantId: 'common' }),
}));

const headers = (values: Record<string, string> = {}) => new Headers(values);
const OPTIONS = { userId: 'user-1', connectionId: 'connection-1' };

afterEach(() => {
  vi.unstubAllGlobals();
  tokenMock.mockClear();
});

describe('classifyGraphError', () => {
  it('maps an unauthorized call to a re-authorize problem', () => {
    expect(classifyGraphError(401, { error: { message: 'Invalid authentication token' } }, headers()))
      .toMatchObject({ code: 'PROVIDER_AUTH_REQUIRED', retryable: false });
  });

  it('maps a forbidden call to a missing scope, carrying the provider reason', () => {
    const error = classifyGraphError(403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }, headers());
    expect(error).toMatchObject({ code: 'INSUFFICIENT_SCOPES', providerReason: 'ErrorAccessDenied' });
  });

  it('distinguishes a missing resource from an expired delta token', () => {
    expect(classifyGraphError(404, {}, headers()).code).toBe('RESOURCE_NOT_FOUND');
    expect(classifyGraphError(410, { error: { code: 'syncStateNotFound' } }, headers()).code).toBe('INVALID_SYNC_CURSOR');
  });

  it('marks throttling and server errors retryable, with Retry-After when given', () => {
    expect(classifyGraphError(429, {}, headers({ 'retry-after': '12' })))
      .toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 12 });
    expect(classifyGraphError(503, {}, headers()).code).toBe('UPSTREAM_UNAVAILABLE');
    expect(classifyGraphError(503, {}, headers()).retryable).toBe(true);
  });

  it('is a typed error, so the adapter can branch on it', () => {
    expect(classifyGraphError(400, { error: { code: 'BadRequest', message: 'nope' } }, headers())).toBeInstanceOf(GraphApiError);
  });
});

describe('immutable Graph id preference', () => {
  it('adds the preference only when the caller has completed the translation', async () => {
    const calls: Array<{ url: string; prefer: string | null }> = [];
    vi.stubGlobal('fetch', (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), prefer: new Headers(init?.headers).get('prefer') });
      return ({ ok: true, status: 200, headers: headers(), json: async () => ({ id: 'm-1' }) }) as Response;
    }) as unknown as typeof fetch);

    await graphGet({ ...OPTIONS, immutableIds: false }, '/me/messages/m-1');
    await graphGet({ ...OPTIONS, immutableIds: true }, '/me/messages/m-1');

    expect(calls[0]?.prefer).toBeNull();
    expect(calls[1]?.prefer).toBe('IdType="ImmutableId"');
  });
});

describe('graphUrl', () => {
  it('keeps the escaped select list and drops absent values', () => {
    const url = new URL(graphUrl('/me/contactFolders/folder-1/contacts/delta', {
      $select: 'id,displayName', $top: 200, $skiptoken: undefined, $filter: null,
    }));
    expect(url.searchParams.get('$select')).toBe('id,displayName');
    expect(url.searchParams.get('$top')).toBe('200');
    expect(url.searchParams.has('$skiptoken')).toBe(false);
    expect(url.searchParams.has('$filter')).toBe(false);
  });
});

describe('normalizeGraphBirthday', () => {
  it('takes the date part of the ISO timestamp Graph returns', () => {
    expect(normalizeGraphBirthday('1970-04-01T00:00:00Z')).toBe('1970-04-01');
    expect(normalizeGraphBirthday('1970-04-01')).toBe('1970-04-01');
    expect(normalizeGraphBirthday('')).toBeNull();
    expect(normalizeGraphBirthday('sometime')).toBeNull();
  });
});

describe('graphContactToVCard', () => {
  const contact: GraphContact = {
    id: 'AAMkAGI2',
    displayName: 'Ada Lovelace',
    givenName: 'Ada',
    surname: 'Lovelace',
    nickName: 'Ada',
    emailAddresses: [{ address: 'ada@contoso.test', name: 'Ada Lovelace' }, { address: 'ada.home@example.test' }],
    businessPhones: ['+48 22 000 00 00'],
    homePhones: ['+48 22 111 11 11'],
    mobilePhone: '+48 600 000 000',
    companyName: 'Analytical Engines',
    jobTitle: 'Mathematician',
    department: 'Research',
    personalNotes: 'First programmer',
    birthday: '1815-12-10T00:00:00Z',
    businessHomePage: 'https://example.test/ada',
    businessAddress: { street: 'St James Square 1', city: 'London', postalCode: 'SW1', countryOrRegion: 'UK' },
    homeAddress: { city: 'London' },
    otherAddress: {},
    categories: ['Friends', ''],
  };

  it('maps names, labelled phones, org fields, notes and addresses', () => {
    const card = graphContactToVCard(contact, contactUidForGraphContact(contact.id));
    expect(card).toMatchObject({
      uid: 'msgraph-AAMkAGI2',
      displayName: 'Ada Lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace',
      nickname: 'Ada',
      organization: 'Analytical Engines',
      title: 'Mathematician',
      role: 'Research',
      notes: 'First programmer',
      birthday: '1815-12-10',
      categories: ['Friends'],
    });
    // The first e-mail is primary; Graph gives no type, so it is left generic.
    expect(card.emails).toEqual([
      { value: 'ada@contoso.test', type: 'other', primary: true },
      { value: 'ada.home@example.test', type: 'other', primary: false },
    ]);
    expect(card.phones).toEqual([
      { value: '+48 22 000 00 00', type: 'work' },
      { value: '+48 22 111 11 11', type: 'home' },
      { value: '+48 600 000 000', type: 'cell' },
    ]);
    expect(card.urls).toEqual([{ value: 'https://example.test/ada', type: 'work' }]);
    // An empty address object contributes nothing.
    expect(card.addresses).toEqual([
      { type: 'work', pobox: '', extended: '', street: 'St James Square 1', locality: 'London', region: '', postalCode: 'SW1', country: 'UK' },
      { type: 'home', pobox: '', extended: '', street: '', locality: 'London', region: '', postalCode: '', country: '' },
    ]);
  });

  it('identifies a contact by its id, never by an e-mail address', () => {
    expect(contactUidForGraphContact('AAMkAGI2')).toBe('msgraph-AAMkAGI2');
    // A contact with no e-mail still has an identity.
    const card = graphContactToVCard({ id: 'no-mail', givenName: 'Anon' }, 'msgraph-no-mail');
    expect(card.uid).toBe('msgraph-no-mail');
    expect(card.emails).toEqual([]);
    expect(card.phones).toEqual([]);
    expect(card.addresses).toEqual([]);
    // With no display name, the primary e-mail is the best label available.
    expect(card.displayName).toBeNull();
    expect(graphContactToVCard({ id: 'x', emailAddresses: [{ address: 'a@b.test' }] }, 'msgraph-x').displayName).toBe('a@b.test');
  });
});

describe('fetchContactsPage', () => {
  const json = (body: unknown, status = 200): Response =>
    ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body }) as Response;

  it('reads the default folder delta with a select list and surfaces the delta link', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      value: [{ id: 'c1', displayName: 'Ada' }],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contactFolders/folder-1/contacts/delta?$deltatoken=abc',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchContactsPage(OPTIONS, { folderId: 'folder-1' });
    expect(page.contacts).toHaveLength(1);
    expect(page.nextLink).toBeNull();
    expect(page.deltaLink).toContain('$deltatoken=abc');
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/me/contactFolders/folder-1/contacts/delta');
    expect(url).toContain('%24select=id');
    expect(url).toContain('%24top=200');
  });

  it('reads the default collection without inventing a contact folder id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta?$deltatoken=default' }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchContactsPage(OPTIONS, { defaultContacts: true });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/me/contacts/delta');
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('/contactFolders/contacts/');
  });

  it('marks a deleted entry from its @removed marker', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      value: [{ id: 'gone', '@removed': { reason: 'deleted' } }],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=next',
    })));
    const page = await fetchContactsPage(OPTIONS, { folderId: 'folder-1' });
    expect(page.contacts[0]?.removed).toEqual({ reason: 'deleted' });
  });

  it('follows the absolute next link exactly as Graph provided it', async () => {
    const next = 'https://graph.microsoft.com/v1.0/me/contactFolders/folder-1/contacts/delta?$skiptoken=xyz';
    const fetchMock = vi.fn().mockResolvedValue(json({ value: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchContactsPage(OPTIONS, { nextLink: next });
    expect(String(fetchMock.mock.calls[0][0])).toBe(next);
  });

  it('refreshes once and retries after a 401', async () => {
    tokenMock
      .mockResolvedValueOnce({ accessToken: 'stale', expiresAt: new Date(Date.now() + 3600_000), generation: 1, refreshed: false, scopes: [] })
      .mockResolvedValueOnce({ accessToken: 'fresh', expiresAt: new Date(Date.now() + 3600_000), generation: 2, refreshed: true, scopes: [] });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, headers: new Headers(), json: async () => ({ error: { message: 'expired' } }) } as Response)
      .mockResolvedValueOnce(json({ value: [{ id: 'c1' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchContactsPage(OPTIONS, { folderId: 'folder-1' });
    expect(page.contacts).toHaveLength(1);
    expect(tokenMock).toHaveBeenCalledTimes(2);
    // The retry uses the refreshed token, and the second read forces a refresh.
    expect(String((fetchMock.mock.calls[1][1] as RequestInit).headers && JSON.stringify((fetchMock.mock.calls[1][1] as { headers: Record<string, string> }).headers))).toContain('fresh');
    expect(tokenMock.mock.calls[1][0]).toMatchObject({ skewSeconds: 60 * 60 * 24 * 365 });
  });

  it('turns an expired delta token into the rebuild signal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: { code: 'syncStateNotFound', message: 'delta token expired' } }, 410)));
    await expect(graphGet(OPTIONS, '/me/contactFolders/folder-1/contacts/delta')).rejects.toMatchObject({ code: 'INVALID_SYNC_CURSOR' });
  });
});

describe('contact folder discovery', () => {
  const json = (body: unknown, status = 200): Response =>
    ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body }) as Response;

  it('lists the mailbox’s folders, including a level of children, instead of assuming an id', async () => {
    // GRAPH-03: `contactFolder` has no well-known-name property, so the folder id has to be discovered. The
    // request asks only for properties the v1.0 resource has, and a nested folder is enumerated as well — a
    // contact in a child folder would otherwise stay invisible.
    const fetchMock = vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/childFolders')) {
        return json({ value: [{ id: 'child-1', displayName: 'Team', parentFolderId: 'folder-1' }] });
      }
      return json({ value: [{ id: 'folder-1', displayName: 'Contacts', parentFolderId: null }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const folders = await discoverGraphContactFolders(OPTIONS);
    expect(folders).toEqual([
      { id: 'folder-1', displayName: 'Contacts', parentFolderId: null },
      { id: 'child-1', displayName: 'Team', parentFolderId: 'folder-1' },
    ]);
    const url = decodeURIComponent(String(fetchMock.mock.calls[0][0]));
    expect(url).toContain('/me/contactFolders');
    expect(url).toContain('$select=id,displayName,parentFolderId');
    expect(decodeURIComponent(String(fetchMock.mock.calls[1][0]))).toContain('/me/contactFolders/folder-1/childFolders');
  });

  it('retains a provider-listed folder with a parent id and walks deeper descendants', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('folder-A/childFolders')) return json({ value: [{ id: 'folder-B', displayName: 'Team', parentFolderId: 'folder-A' }] });
      if (target.includes('folder-B/childFolders')) return json({ value: [{ id: 'folder-C', displayName: 'Nested', parentFolderId: 'folder-B' }] });
      if (target.includes('folder-C/childFolders')) return json({ value: [] });
      return json({ value: [{ id: 'folder-A', displayName: 'Kontakty', parentFolderId: 'root-A' }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(discoverGraphContactFolders(OPTIONS)).resolves.toEqual([
      { id: 'folder-A', displayName: 'Kontakty', parentFolderId: 'root-A' },
      { id: 'folder-B', displayName: 'Team', parentFolderId: 'folder-A' },
      { id: 'folder-C', displayName: 'Nested', parentFolderId: 'folder-B' },
    ]);
  });

  it('picks a top-level folder as the default, and answers null rather than guessing', () => {
    expect(defaultGraphContactFolder([
      { id: 'nested', displayName: 'Team', parentFolderId: 'root' },
      { id: 'contacts', displayName: 'Contacts', parentFolderId: null },
    ])?.id).toBe('contacts');
    // A localized mailbox still has a top-level folder: the name is a hint, not the identity.
    expect(defaultGraphContactFolder([{ id: 'kontakty', displayName: 'Kontakty', parentFolderId: null }])?.id).toBe('kontakty');
    expect(defaultGraphContactFolder([{ id: 'nested', displayName: 'Team', parentFolderId: 'root' }])).toBeNull();
    expect(defaultGraphContactFolder([])).toBeNull();
  });
});

describe('the Graph mapper carries the fields with local columns', () => {
  it('maps the birthday and IM addresses, and never invents an anniversary', () => {
    const parsed = graphContactToVCard({
      id: 'c1', displayName: 'Ada Lovelace',
      emailAddresses: [{ address: 'ada@example.test', name: 'Ada' }],
      birthday: '1815-12-10T00:00:00Z',
      imAddresses: ['ada@jabber.example', ''],
    }, 'book-1');
    expect(parsed.birthday).toBe('1815-12-10');
    // GRAPH-03: the v1.0 contact resource has no anniversary property (beta names a different one), so the
    // mapper has nothing to read and must not claim otherwise.
    expect(parsed.anniversary).toBeNull();
    // A bare Graph IM address carries no protocol, so it is typed `other` rather than guessed, and
    // an empty entry is not an address.
    expect(parsed.instantMessages).toEqual([{ value: 'ada@jabber.example', type: 'other' }]);
  });

  it('leaves both empty when Graph has neither', () => {
    const parsed = graphContactToVCard({ id: 'c2', displayName: 'Anon' }, 'book-1');
    expect(parsed.anniversary).toBeNull();
    expect(parsed.instantMessages).toEqual([]);
  });

  it('never requests the anniversary from the v1.0 contact resource', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await fetchContactsPage(OPTIONS, { folderId: 'folder-1', top: 10 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('anniversary');
    expect(decodeURIComponent(calls[0]!)).toContain('birthday');
  });
});
