import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchMailFolders,
  fetchMessagesDeltaPage,
  fetchWellKnownFolderIds,
  graphFolderPathMap,
  localFolderForGraphFolder,
  localMessageForGraphMessage,
  providerUidForGraphMessage,
} from './graphMail.js';
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
    // The role comes from the id the alias resolved to, never from the display name: v1.0 does not return a
    // `wellKnownName` property at all (GRAPH-01).
    const inbox = localFolderForGraphFolder({ id: 'AAA', displayName: 'Skrzynka odbiorcza' }, null, 'inbox');
    expect(inbox).toMatchObject({ path: 'INBOX', name: 'Skrzynka odbiorcza', specialUse: '\\Inbox' });

    expect(localFolderForGraphFolder({ id: 'B', displayName: 'Deleted Items' }, null, 'deleteditems').path).toBe('Trash');
    expect(localFolderForGraphFolder({ id: 'C', displayName: 'Junk Email' }, null, 'junkemail')).toMatchObject({ path: 'Spam', specialUse: '\\Junk' });
    expect(localFolderForGraphFolder({ id: 'D', displayName: 'Sent Items' }, null, 'sentitems').specialUse).toBe('\\Sent');
    expect(localFolderForGraphFolder({ id: 'E', displayName: 'Drafts' }, null, 'drafts').specialUse).toBe('\\Drafts');
    expect(localFolderForGraphFolder({ id: 'F', displayName: 'Archive' }, null, 'archive').specialUse).toBe('\\Archive');
  });

  it('keeps the canonical path when a well-known folder is renamed', () => {
    // This is why the well-known role is read separately from the display name: the
    // application compares `folder` to INBOX, and a renamed Inbox must keep working.
    const renamed = localFolderForGraphFolder({ id: 'AAA', displayName: 'Poczta' }, null, 'inbox');
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
    { id: 'inbox', displayName: 'Inbox', childFolderCount: 1 },
    { id: 'work', displayName: 'Work', parentFolderId: 'inbox', childFolderCount: 1 },
    { id: 'projects', displayName: 'Projects', parentFolderId: 'work' },
    { id: 'sent', displayName: 'Sent Items' },
    { id: 'orphan', displayName: 'Orphan', parentFolderId: 'missing-parent' },
  ];
  const wellKnown = new Map([['inbox', 'inbox'], ['sent', 'sentitems']]);

  it('resolves parents before children, even when the listing is not ordered that way', () => {
    const mapped = graphFolderPathMap(folders, wellKnown);
    expect(mapped.get('projects')?.path).toBe('INBOX/Work/Projects');
    expect(mapped.get('work')?.path).toBe('INBOX/Work');
    expect(mapped.get('sent')?.path).toBe('Sent');
  });

  it('treats a folder whose parent is absent from the listing as a root', () => {
    expect(graphFolderPathMap(folders, wellKnown).get('orphan')?.path).toBe('Orphan');
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

  it('never selects the beta-only wellKnownName property from the v1.0 endpoint', async () => {
    // GRAPH-01: `wellKnownName` is a beta `mailFolder` property. Asking the v1.0 endpoint for it is a contract
    // violation that can fail the entire listing, which is what stopped Microsoft mail from syncing at all.
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return jsonResponse({ value: [] });
    }));
    await fetchMailFolders(OPTIONS);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every(url => !url.includes('wellKnownName'))).toBe(true);
  });
});

describe('resolving well-known folder aliases to real ids', () => {
  const aliasOf = (url: string) => new URL(url).pathname.split('/').pop() ?? '';

  it('resolves every alias through a v1.0 path segment and maps it to the returned id', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return jsonResponse({ id: `id-${aliasOf(String(url))}` });
    }));
    const byId = await fetchWellKnownFolderIds(OPTIONS);
    expect(byId.get('id-inbox')).toBe('inbox');
    expect(byId.get('id-sentitems')).toBe('sentitems');
    expect(byId.get('id-deleteditems')).toBe('deleteditems');
    expect(urls.every(url => url.includes('/me/mailFolders/'))).toBe(true);
    // v1.0 accepts the alias in the path; it does not accept the property in `$select`.
    expect(urls.every(url => !url.includes('wellKnownName'))).toBe(true);
  });

  it('skips an alias this mailbox does not have, but rethrows any other failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (aliasOf(String(url)) === 'archive') return new Response('not found', { status: 404 });
      return jsonResponse({ id: `id-${aliasOf(String(url))}` });
    }));
    const byId = await fetchWellKnownFolderIds(OPTIONS);
    expect(byId.has('id-archive')).toBe(false);
    expect(byId.get('id-inbox')).toBe('inbox');

    // A 500 is not "this mailbox has no Inbox": an incomplete role map must not be treated as a complete one.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(fetchWellKnownFolderIds(OPTIONS)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
});

describe('projecting a Graph message onto the local row', () => {
  const message = {
    id: 'AAMkAD-graph-1',
    internetMessageId: '<abc@contoso.test>',
    conversationId: 'conv-1',
    subject: 'Quarterly plan',
    bodyPreview: 'Here is the plan…',
    receivedDateTime: '2026-03-04T09:15:00Z',
    isRead: true,
    isDraft: false,
    hasAttachments: true,
    flag: { flagStatus: 'flagged' },
    from: { emailAddress: { name: 'Ada Lovelace', address: 'ada@contoso.test' } },
    toRecipients: [{ emailAddress: { address: 'sam@contoso.test' } }, { emailAddress: { address: '' } }],
    ccRecipients: [{ emailAddress: { name: 'Grace', address: 'grace@contoso.test' } }],
    replyTo: [{ emailAddress: { address: 'replies@contoso.test' } }],
    changeKey: 'change-1',
  };

  it('maps the fields the local list reads', () => {
    const local = localMessageForGraphMessage(message);
    expect(local).toMatchObject({
      providerMessageId: 'AAMkAD-graph-1',
      // The RFC header is metadata, not identity.
      messageId: '<abc@contoso.test>',
      threadId: 'conv-1',
      subject: 'Quarterly plan',
      fromName: 'Ada Lovelace',
      fromEmail: 'ada@contoso.test',
      snippet: 'Here is the plan…',
      isRead: true,
      isStarred: true,
      hasAttachments: true,
      isDraft: false,
    });
    expect(local?.date?.toISOString()).toBe('2026-03-04T09:15:00.000Z');
    // A recipient without an address is dropped rather than stored as blank.
    expect(local?.toAddresses).toEqual([{ name: null, address: 'sam@contoso.test' }]);
    expect(local?.ccAddresses).toEqual([{ name: 'Grace', address: 'grace@contoso.test' }]);
    expect(local?.replyTo).toEqual([{ name: null, address: 'replies@contoso.test' }]);
  });

  it('treats anything other than a flagged status as unstarred', () => {
    expect(localMessageForGraphMessage({ ...message, flag: { flagStatus: 'notFlagged' } })?.isStarred).toBe(false);
    expect(localMessageForGraphMessage({ ...message, flag: null })?.isStarred).toBe(false);
  });

  it('falls back to the sent date when the received date is absent', () => {
    const local = localMessageForGraphMessage({ ...message, receivedDateTime: null, sentDateTime: '2026-03-01T08:00:00Z' });
    expect(local?.date?.toISOString()).toBe('2026-03-01T08:00:00.000Z');
  });

  it('returns null for a delta deletion entry and for a message with no id', () => {
    expect(localMessageForGraphMessage({ id: 'gone', '@removed': { reason: 'deleted' } })).toBeNull();
    expect(localMessageForGraphMessage({ id: '' })).toBeNull();
  });
});

describe('the compatibility uid a Graph message gets', () => {
  it('is stable for one id and different between ids', () => {
    const first = providerUidForGraphMessage('AAMkAD-graph-1');
    expect(providerUidForGraphMessage('AAMkAD-graph-1')).toBe(first);
    expect(providerUidForGraphMessage('AAMkAD-graph-2')).not.toBe(first);
  });

  it('is a positive 63-bit number, so it fits the BIGINT column', () => {
    const uid = providerUidForGraphMessage('AAMkAD-graph-1');
    expect(BigInt(uid) > 0n).toBe(true);
    expect(BigInt(uid) < (1n << 63n)).toBe(true);
  });

  it('offers a different number for the next attempt, for a collision', () => {
    expect(providerUidForGraphMessage('AAMkAD-graph-1', 1)).not.toBe(providerUidForGraphMessage('AAMkAD-graph-1'));
  });
});

describe('reading a message delta page', () => {
  it('asks the folder delta endpoint with the selected fields on the first call', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return jsonResponse({ value: [{ id: 'm1' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=1' });
    }));

    const page = await fetchMessagesDeltaPage(OPTIONS, { folderId: 'graph-inbox' });
    expect(page.messages).toEqual([{ id: 'm1' }]);
    expect(page.deltaLink).toBe('https://graph.microsoft.com/v1.0/delta?token=1');
    expect(urls[0]).toContain('/me/mailFolders/graph-inbox/messages/delta');
    expect(urls[0]).toContain('select=');
  });

  it('follows the next link and then the stored delta link exactly as Graph issued them', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(String(url));
      return jsonResponse({ value: [] });
    }));

    await fetchMessagesDeltaPage(OPTIONS, { folderId: 'f', nextLink: 'https://graph.microsoft.com/v1.0/next?page=2' });
    await fetchMessagesDeltaPage(OPTIONS, { folderId: 'f', deltaLink: 'https://graph.microsoft.com/v1.0/delta?token=stored' });
    expect(seen).toEqual([
      'https://graph.microsoft.com/v1.0/next?page=2',
      'https://graph.microsoft.com/v1.0/delta?token=stored',
    ]);
  });
});
