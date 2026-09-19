import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMailFolders, graphFolderPathMap, localFolderForGraphFolder } from './graphMail.js';
import type { GraphMailFolder } from './graphMail.js';

const tokenMock = vi.hoisted(() => vi.fn(async () => ({
  accessToken: 'graph-token-1', expiresAt: new Date(Date.now() + 3600_000), generation: 1, refreshed: false, scopes: [],
})));

vi.mock('../../providerTokenService.js', () => ({ getMicrosoftAccessToken: tokenMock }));
vi.mock('../../providerAuthService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../providerAuthService.js')>()),
  microsoftConfigFromEnv: () => ({ clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://x/cb', tenantId: 'common' }),
}));

const OPTIONS = { userId: 'user-1', connectionId: 'connection-1' };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  tokenMock.mockClear();
});

describe('mapping a Graph folder onto the local folder model', () => {
  it('gives a well-known folder its canonical local path and special use', () => {
    const inbox = localFolderForGraphFolder({ id: 'AAA', displayName: 'Skrzynka odbiorcza', wellKnownName: 'inbox' }, null);
    expect(inbox).toMatchObject({ path: 'INBOX', name: 'Skrzynka odbiorcza', specialUse: '\\Inbox' });

    expect(localFolderForGraphFolder({ id: 'B', displayName: 'Deleted Items', wellKnownName: 'deleteditems' }, null).path).toBe('Trash');
    expect(localFolderForGraphFolder({ id: 'C', displayName: 'Junk Email', wellKnownName: 'junkemail' }, null)).toMatchObject({ path: 'Spam', specialUse: '\\Junk' });
    expect(localFolderForGraphFolder({ id: 'D', displayName: 'Sent Items', wellKnownName: 'sentitems' }, null).specialUse).toBe('\\Sent');
    expect(localFolderForGraphFolder({ id: 'E', displayName: 'Drafts', wellKnownName: 'drafts' }, null).specialUse).toBe('\\Drafts');
    expect(localFolderForGraphFolder({ id: 'F', displayName: 'Archive', wellKnownName: 'archive' }, null).specialUse).toBe('\\Archive');
  });

  it('keeps the canonical path when a well-known folder is renamed', () => {
    // This is why the well-known role is read separately from the display name: the
    // application compares `folder` to INBOX, and a renamed Inbox must keep working.
    const renamed = localFolderForGraphFolder({ id: 'AAA', displayName: 'Poczta', wellKnownName: 'inbox' }, null);
    expect(renamed.path).toBe('INBOX');
    expect(renamed.name).toBe('Poczta');
  });

  it('derives a nested path for an ordinary folder and leaves special use empty', () => {
    expect(localFolderForGraphFolder({ id: 'X', displayName: 'Projects' }, 'Work')).toMatchObject({
      path: 'Work/Projects', name: 'Projects', specialUse: null, delimiter: '/',
    });
  });

  it('carries the provider counts and clamps a negative or absent one', () => {
    expect(localFolderForGraphFolder({ id: 'X', displayName: 'X', totalItemCount: 12, unreadItemCount: 3 }, null))
      .toMatchObject({ totalCount: 12, unreadCount: 3 });
    expect(localFolderForGraphFolder({ id: 'X', displayName: 'X', totalItemCount: -1 }, null)).toMatchObject({ totalCount: 0, unreadCount: 0 });
  });

  it('falls back to the id when a folder has no display name', () => {
    expect(localFolderForGraphFolder({ id: 'AAA', displayName: '   ' }, null).name).toBe('AAA');
  });
});

describe('mapping a whole folder tree', () => {
  const folders: GraphMailFolder[] = [
    { id: 'inbox', displayName: 'Inbox', wellKnownName: 'inbox', childFolderCount: 1 },
    { id: 'work', displayName: 'Work', parentFolderId: 'inbox', childFolderCount: 1 },
    { id: 'projects', displayName: 'Projects', parentFolderId: 'work' },
    { id: 'sent', displayName: 'Sent Items', wellKnownName: 'sentitems' },
    { id: 'orphan', displayName: 'Orphan', parentFolderId: 'missing-parent' },
  ];

  it('resolves parents before children, even when the listing is not ordered that way', () => {
    const mapped = graphFolderPathMap(folders);
    expect(mapped.get('projects')?.path).toBe('INBOX/Work/Projects');
    expect(mapped.get('work')?.path).toBe('INBOX/Work');
    expect(mapped.get('sent')?.path).toBe('Sent');
  });

  it('treats a folder whose parent is absent from the listing as a root', () => {
    expect(graphFolderPathMap(folders).get('orphan')?.path).toBe('Orphan');
  });

  it('breaks a parent cycle instead of recursing for ever', () => {
    const cyclic: GraphMailFolder[] = [
      { id: 'a', displayName: 'A', parentFolderId: 'b' },
      { id: 'b', displayName: 'B', parentFolderId: 'a' },
    ];
    const mapped = graphFolderPathMap(cyclic);
    expect(mapped.size).toBe(2);
    // The first folder visited closes the cycle, so it becomes the root and the
    // second nests under it. The exact shape is arbitrary but deterministic, which
    // is what matters: a malformed tree yields paths rather than a hang.
    expect(mapped.get('a')?.path).toBe('B/A');
    expect(mapped.get('b')?.path).toBe('B');
  });

  it('serves a repeated listing from the same stable path, so a sync is idempotent', () => {
    const first = graphFolderPathMap(folders).get('projects')?.path;
    const second = graphFolderPathMap(folders).get('projects')?.path;
    expect(second).toBe(first);
  });
});

describe('reading the folder tree from Graph', () => {
  it('walks the top level, follows @odata.nextLink and descends into childFolders', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).includes('/childFolders')) {
        return jsonResponse({ value: [{ id: 'inbox', displayName: 'Inbox', wellKnownName: 'inbox', childFolderCount: 0 }] });
      }
      if (String(url).includes('page=2')) {
        return jsonResponse({ value: [{ id: 'sent', displayName: 'Sent Items', wellKnownName: 'sentitems' }] });
      }
      return jsonResponse({
        value: [{ id: 'root', displayName: 'Root', childFolderCount: 1 }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders?page=2',
      });
    }));

    const folders = await fetchMailFolders(OPTIONS);
    expect(folders.map(folder => folder.id)).toEqual(['root', 'sent', 'inbox']);
    expect(urls.some(url => url.includes('select='))).toBe(true);
    expect(urls.some(url => url.includes('/me/mailFolders/root/childFolders'))).toBe(true);
  });

  it('stops at the folder budget rather than following an endless tree', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      value: [{ id: 'a', displayName: 'A' }, { id: 'b', displayName: 'B' }, { id: 'c', displayName: 'C' }],
    })));
    const folders = await fetchMailFolders(OPTIONS, { maxFolders: 2 });
    expect(folders).toHaveLength(2);
  });

  it('ignores a folder Graph returned without an id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ value: [{ displayName: 'No id' }, { id: 'ok', displayName: 'OK' }] })));
    await expect(fetchMailFolders(OPTIONS)).resolves.toEqual([{ id: 'ok', displayName: 'OK' }]);
  });
});
