import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchGmailHistoryPage,
  fetchGmailMessage,
  fetchGmailThread,
  gmailHeaderMap,
  gmailHistoryChanges,
  gmailMessageHasAttachments,
  gmailProviderNamespace,
  localMessageForGmailMessage,
  providerUidForGmailMessage,
} from './gmailMail.js';
import type { GmailMessage } from './gmailMail.js';
import { classifyGoogleError } from './googleApiClient.js';

const tokenMock = vi.hoisted(() => vi.fn(async () => ({
  accessToken: 'google-token-1', expiresAt: new Date(Date.now() + 3600_000), generation: 1, refreshed: false, scopes: [],
})));

vi.mock('../../providerTokenService.js', () => ({ getGoogleAccessToken: tokenMock }));

const OPTIONS = {
  userId: 'user-1',
  connectionId: 'connection-1',
  config: { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://inboxora.example/cb' },
};

const PATH_BY_LABEL = new Map<string, string>([
  ['INBOX', 'INBOX'], ['SENT', 'Sent'], ['DRAFT', 'Drafts'], ['TRASH', 'Trash'], ['SPAM', 'Spam'],
  ['Label_1', 'Work'],
]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function headers(...entries: Array<[string, string]>): Array<{ name: string; value: string }> {
  return entries.map(([name, value]) => ({ name, value }));
}

const MESSAGE: GmailMessage = {
  id: '18f2a4c0d1e2f3a4',
  threadId: '18f2a4c0d1e2f3a0',
  labelIds: ['UNREAD', 'INBOX', 'Label_1'],
  snippet: 'The invoice is attached',
  internalDate: String(Date.UTC(2026, 8, 1, 9, 30)),
  sizeEstimate: 4096,
  payload: {
    mimeType: 'multipart/mixed',
    headers: headers(
      ['From', 'Jan Kowalski <jan@example.test>'],
      ['To', 'Me <me@example.test>, Other <other@example.test>'],
      ['Cc', 'cc@example.test'],
      ['Reply-To', 'noreply@example.test'],
      ['Subject', '=?UTF-8?B?RmFrdHVyYQ==?='],
      ['Message-ID', '<invoice-1@example.test>'],
      ['Date', 'Tue, 01 Sep 2026 09:30:00 +0000'],
    ),
    parts: [
      { partId: '0', mimeType: 'text/plain' },
      { partId: '1', mimeType: 'application/pdf', filename: 'invoice.pdf' },
    ],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  tokenMock.mockClear();
});

describe('Gmail message identity', () => {
  it('derives a stable non-zero compatibility uid from the provider id', () => {
    const first = providerUidForGmailMessage('18f2a4c0d1e2f3a4');
    expect(first).toBe(providerUidForGmailMessage('18f2a4c0d1e2f3a4'));
    expect(BigInt(first) > 0n).toBe(true);
    expect(BigInt(first) < (1n << 63n)).toBe(true);
    expect(providerUidForGmailMessage('18f2a4c0d1e2f3a4', 1)).not.toBe(first);
  });

  it('namespaces the provider identity as gmail, so the conversation engine reads it as strong', () => {
    expect(gmailProviderNamespace('account-1')).toMatch(/^gmail:account-1:/);
  });
});

describe('projecting a Gmail message onto the local row', () => {
  it('projects headers, labels, flags and the primary folder', () => {
    const local = localMessageForGmailMessage(MESSAGE, { accountId: 'account-1', pathByLabelId: PATH_BY_LABEL });
    if (!local) throw new Error('expected the message to project');
    expect(local).toMatchObject({
      providerMessageId: '18f2a4c0d1e2f3a4',
      messageId: '<invoice-1@example.test>',
      providerThreadId: '18f2a4c0d1e2f3a0',
      threadId: 'gmail:18f2a4c0d1e2f3a0',
      subject: 'Faktura',
      fromName: 'Jan Kowalski',
      fromEmail: 'jan@example.test',
      // UNREAD means unread; its absence means read.
      isRead: false,
      isStarred: false,
      hasAttachments: true,
      isDraft: false,
      folderPath: 'INBOX',
      labels: ['UNREAD', 'INBOX', 'Label_1'],
    });
    expect(local.toAddresses).toEqual([
      { name: 'Me', address: 'me@example.test' },
      { name: 'Other', address: 'other@example.test' },
    ]);
    expect(local.ccAddresses).toEqual([{ name: null, address: 'cc@example.test' }]);
    expect(local.replyTo).toEqual([{ name: null, address: 'noreply@example.test' }]);
    expect(local.date?.toISOString()).toBe('2026-09-01T09:30:00.000Z');
  });

  it('reads read and starred from the absence of UNREAD and the presence of STARRED', () => {
    const local = localMessageForGmailMessage({ ...MESSAGE, labelIds: ['STARRED', 'SENT'] }, { accountId: 'account-1', pathByLabelId: PATH_BY_LABEL });
    expect(local).toMatchObject({ isRead: true, isStarred: true, folderPath: 'Sent' });
  });

  it('files an archived message under no folder rather than inventing one', () => {
    const local = localMessageForGmailMessage({ ...MESSAGE, labelIds: ['STARRED', 'IMPORTANT'] }, { accountId: 'account-1', pathByLabelId: PATH_BY_LABEL });
    expect(local?.folderPath).toBeNull();
  });

  it('keeps the extra labels a message carries beside its primary folder', () => {
    const local = localMessageForGmailMessage({ ...MESSAGE, labelIds: ['INBOX', 'Label_1', 'IMPORTANT'] }, { accountId: 'account-1', pathByLabelId: PATH_BY_LABEL });
    expect(local?.folderPath).toBe('INBOX');
    expect(local?.labels).toEqual(['INBOX', 'Label_1', 'IMPORTANT']);
  });

  it('has no identity without an id', () => {
    expect(localMessageForGmailMessage({ ...MESSAGE, id: '' }, { accountId: 'account-1', pathByLabelId: PATH_BY_LABEL })).toBeNull();
  });
});

describe('reading Gmail structure', () => {
  it('lowercases header names and keeps the first occurrence', () => {
    const map = gmailHeaderMap({ id: 'm', payload: { headers: headers(['Subject', 'One'], ['subject', 'Two']) } });
    expect(map.get('subject')).toBe('One');
  });

  it('finds an attachment in a nested part', () => {
    expect(gmailMessageHasAttachments({ mimeType: 'multipart/mixed', parts: [{ mimeType: 'multipart/related', parts: [{ filename: 'x.png' }] }] })).toBe(true);
    expect(gmailMessageHasAttachments({ mimeType: 'text/plain', parts: [{ filename: '' }, { mimeType: 'text/html' }] })).toBe(false);
    expect(gmailMessageHasAttachments(null)).toBe(false);
  });

  it('collapses a history feed into the threads to re-read and the messages that are gone', () => {
    const changes = gmailHistoryChanges([
      { id: '100', messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] },
      { id: '101', labelsRemoved: [{ message: { id: 'm1', threadId: 't1' }, labelIds: ['INBOX'] }] },
      { id: '102', messagesDeleted: [{ message: { id: 'm2', threadId: 't2' } }] },
      { id: '103', messages: [{ id: 'm3', threadId: 't1' }] },
    ]);
    expect(changes.threadIds.sort()).toEqual(['t1', 't2']);
    expect(changes.deletedMessageIds).toEqual(['m2']);
  });
});

describe('reading from the Gmail REST surface', () => {
  it('asks for the metadata headers the projector needs, once per header', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      return jsonResponse(MESSAGE);
    }));

    await fetchGmailMessage(OPTIONS, '18f2a4c0d1e2f3a4');
    expect(urls[0]).toContain('/gmail/v1/users/me/messages/18f2a4c0d1e2f3a4');
    expect(urls[0]).toContain('format=metadata');
    expect(urls[0]).toContain('metadataHeaders=From');
    expect(urls[0]).toContain('metadataHeaders=References');

    await fetchGmailThread(OPTIONS, '18f2a4c0d1e2f3a0');
    expect(urls[1]).toContain('/gmail/v1/users/me/threads/18f2a4c0d1e2f3a0');
    expect(urls[1]).toContain('format=metadata');
  });

  it('passes the page token and the start history id through', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      return jsonResponse({ history: [], nextPageToken: 'next', historyId: '200' });
    }));

    const page = await fetchGmailHistoryPage(OPTIONS, { startHistoryId: '150', pageToken: 'p2' });
    expect(urls[0]).toContain('startHistoryId=150');
    expect(urls[0]).toContain('pageToken=p2');
    expect(page).toMatchObject({ nextPageToken: 'next', historyId: '200' });
  });

  it('classifies an aged-out history id as a not-found the sync treats as an expired cursor', () => {
    // Gmail answers `404` for a `startHistoryId` it no longer holds; the sync's
    // rebuild path keys on exactly this code, so the classification is asserted here
    // rather than only through the database.
    const error = classifyGoogleError(404, { error: { message: 'Requested entity was not found.' } }, new Headers());
    expect(error.code).toBe('RESOURCE_NOT_FOUND');
    expect(error.retryable).toBe(false);
  });
});
