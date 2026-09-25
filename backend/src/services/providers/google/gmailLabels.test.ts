import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchGmailLabels,
  gmailFolderPathMap,
  gmailLabelIsFolder,
  localFolderForGmailLabel,
  primaryFolderPathForGmailLabels,
} from './gmailLabels.js';
import type { GmailLabel } from './gmailLabels.js';

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

afterEach(() => {
  vi.unstubAllGlobals();
  tokenMock.mockClear();
});

describe('projecting a Gmail label onto the local folder model', () => {
  it('gives a system mailbox its canonical local path and special use', () => {
    // This is why the label id, not the display name, is the identity: the
    // application compares `folder` to INBOX, and a localised Gmail account must
    // still work.
    expect(localFolderForGmailLabel({ id: 'INBOX', name: 'Odebrane', type: 'system' }))
      .toMatchObject({ path: 'INBOX', name: 'Odebrane', specialUse: '\\Inbox', delimiter: '/' });
    expect(localFolderForGmailLabel({ id: 'SENT', name: 'Sent', type: 'system' })).toMatchObject({ path: 'Sent', specialUse: '\\Sent' });
    expect(localFolderForGmailLabel({ id: 'DRAFT', name: 'Drafts', type: 'system' })).toMatchObject({ path: 'Drafts', specialUse: '\\Drafts' });
    expect(localFolderForGmailLabel({ id: 'TRASH', name: 'Trash', type: 'system' })).toMatchObject({ path: 'Trash', specialUse: '\\Trash' });
    expect(localFolderForGmailLabel({ id: 'SPAM', name: 'Spam', type: 'system' })).toMatchObject({ path: 'Spam', specialUse: '\\Junk' });
  });

  it('keeps Gmail\'s own nested name as the path, delimiter and all', () => {
    // Gmail nests by naming a label `Parent/Child`, so `/` is the provider's
    // delimiter rather than one this adapter invents.
    const nested = localFolderForGmailLabel({ id: 'Label_9', name: 'Projects/Inboxora', type: 'user' });
    expect(nested).toMatchObject({ path: 'Projects/Inboxora', name: 'Projects/Inboxora', delimiter: '/', specialUse: null });
  });

  it('does not turn a message-attribute system label into a folder', () => {
    for (const id of ['STARRED', 'IMPORTANT', 'UNREAD', 'CHAT', 'CATEGORY_PROMOTIONS']) {
      expect(gmailLabelIsFolder({ id, name: id, type: 'system' })).toBe(false);
    }
    expect(gmailLabelIsFolder({ id: 'Label_1', name: 'Work', type: 'user' })).toBe(true);
    // A system label this build does not know is refused rather than guessed at.
    expect(gmailLabelIsFolder({ id: 'SOMETHING_NEW', name: 'Something', type: 'system' })).toBe(false);
  });

  it('carries the provider counts and clamps a negative or absent one', () => {
    expect(localFolderForGmailLabel({ id: 'INBOX', name: 'Inbox', type: 'system', messagesTotal: 12, messagesUnread: 3 }))
      .toMatchObject({ totalCount: 12, unreadCount: 3 });
    expect(localFolderForGmailLabel({ id: 'INBOX', name: 'Inbox', type: 'system', messagesTotal: -1 }))
      .toMatchObject({ totalCount: 0, unreadCount: 0 });
  });

  it('falls back to the id when a label has no name', () => {
    expect(localFolderForGmailLabel({ id: 'Label_7', name: '  ', type: 'user' }).name).toBe('Label_7');
  });
});

describe('mapping a whole label set', () => {
  const labels: GmailLabel[] = [
    { id: 'INBOX', name: 'Inbox', type: 'system' },
    { id: 'SENT', name: 'Sent', type: 'system' },
    { id: 'STARRED', name: 'Starred', type: 'system' },
    { id: 'CATEGORY_SOCIAL', name: 'Category social', type: 'system' },
    { id: 'Label_1', name: 'Work', type: 'user' },
    { id: 'Label_2', name: 'Projects/Inboxora', type: 'user' },
  ];

  it('maps every folder-bearing label and skips the message labels', () => {
    const mapped = gmailFolderPathMap(labels);
    expect([...mapped.keys()].sort()).toEqual(['INBOX', 'Label_1', 'Label_2', 'SENT']);
    expect(mapped.get('Label_2')?.path).toBe('Projects/Inboxora');
  });

  it('never gives a canonical path up to a user label', () => {
    // A user label literally named like a system mailbox must not take the path the
    // rest of the application addresses INBOX by.
    const mapped = gmailFolderPathMap([
      { id: 'INBOX', name: 'Inbox', type: 'system' },
      { id: 'Label_5', name: 'INBOX', type: 'user' },
    ]);
    expect(mapped.get('INBOX')?.specialUse).toBe('\\Inbox');
    expect(mapped.has('Label_5')).toBe(false);
  });
});

describe('deriving a message\'s primary folder from its label set', () => {
  const pathByLabelId = new Map<string, string>([
    ['INBOX', 'INBOX'], ['SENT', 'Sent'], ['DRAFT', 'Drafts'], ['TRASH', 'Trash'], ['SPAM', 'Spam'],
    ['Label_1', 'Alpha'], ['Label_2', 'Beta'],
  ]);

  it('prefers the mailbox a user expects to find the message in', () => {
    expect(primaryFolderPathForGmailLabels(['UNREAD', 'INBOX'], pathByLabelId)).toBe('INBOX');
    expect(primaryFolderPathForGmailLabels(['SENT', 'INBOX'], pathByLabelId)).toBe('INBOX');
    expect(primaryFolderPathForGmailLabels(['TRASH'], pathByLabelId)).toBe('Trash');
    expect(primaryFolderPathForGmailLabels(['SPAM', 'UNREAD'], pathByLabelId)).toBe('Spam');
    expect(primaryFolderPathForGmailLabels(['DRAFT', 'SENT'], pathByLabelId)).toBe('Drafts');
    expect(primaryFolderPathForGmailLabels(['SENT'], pathByLabelId)).toBe('Sent');
  });

  it('falls to the first user label in path order, so two runs agree', () => {
    expect(primaryFolderPathForGmailLabels(['Label_2', 'Label_1'], pathByLabelId)).toBe('Alpha');
    expect(primaryFolderPathForGmailLabels(['Label_1', 'Label_2'], pathByLabelId)).toBe('Alpha');
  });

  it('answers null for an archived message rather than inventing a folder', () => {
    // STARRED/IMPORTANT/UNREAD are not mailboxes, so a message carrying only those
    // is archived — Gmail has no Archive label, and the local model says so.
    expect(primaryFolderPathForGmailLabels(['STARRED', 'IMPORTANT'], pathByLabelId)).toBeNull();
    expect(primaryFolderPathForGmailLabels([], pathByLabelId)).toBeNull();
    // A label this account does not model as a folder is not a folder either.
    expect(primaryFolderPathForGmailLabels(['Label_99'], pathByLabelId)).toBeNull();
  });
});

describe('reading the label list', () => {
  it('pages through every label and reports the snapshot as complete', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      if (urls.length === 1) return jsonResponse({ labels: [{ id: 'INBOX', name: 'Inbox', type: 'system' }], nextPageToken: 'page-2' });
      return jsonResponse({ labels: [{ id: 'Label_1', name: 'Work', type: 'user' }] });
    }));

    const result = await fetchGmailLabels(OPTIONS);
    expect(result.complete).toBe(true);
    expect(result.labels.map(label => label.id)).toEqual(['INBOX', 'Label_1']);
    expect(urls[1]).toContain('pageToken=page-2');
  });

  it('reports a truncated listing as incomplete so nothing is reconciled away', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      labels: Array.from({ length: 3 }, (_, index) => ({ id: `Label_${index}`, name: `L${index}`, type: 'user' })),
    })));

    const result = await fetchGmailLabels(OPTIONS, { maxLabels: 2 });
    expect(result.complete).toBe(false);
    expect(result.labels).toHaveLength(2);
  });
});
