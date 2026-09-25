import { describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), project: vi.fn() }));
vi.mock('./gmailMail.js', () => ({ fetchGmailMessageIds: provider.list, fetchGmailMessage: provider.get, localMessageForGmailMessage: provider.project }));

import { resolveGmailMessageIdentity } from './gmailLegacyMessageIdentity.js';
import type { GmailIdentityQueryExecutor } from './gmailLegacyMessageIdentity.js';

const API = { userId: 'user-1', connectionId: 'connection-1', config: { clientId: 'id', clientSecret: 'secret', redirectUri: 'https://example.test/cb' } };
function client(rows: Array<Record<string, unknown>> = []) {
  return { query: vi.fn(async <T extends Record<string, unknown>>() => ({ rows: rows as T[] })) } as GmailIdentityQueryExecutor;
}

describe('legacy Gmail API identity resolution', () => {
  it('uses the direct provider id without searching Gmail', async () => {
    const db = client([{ provider_thread_id: 'thread-1' }]);
    await expect(resolveGmailMessageIdentity(db, API, { messageId: 'row-1', accountId: 'account-1', directProviderMessageId: 'gmail-message-1', rfcMessageId: '<rfc@example.test>' })).resolves.toEqual({ kind: 'resolved', providerMessageId: 'gmail-message-1', providerThreadId: 'thread-1', source: 'direct' });
    expect(provider.list).not.toHaveBeenCalled();
  });
  it('uses exactly one verified native local sibling', async () => {
    const db = client([{ provider_message_id: 'gmail-native-1', provider_thread_id: 'thread-2' }]);
    await expect(resolveGmailMessageIdentity(db, API, { messageId: 'legacy-row', accountId: 'account-1', rfcMessageId: '<rfc@example.test>', fromEmail: 'sender@example.test', date: '2026-09-16T16:37:00Z' })).resolves.toEqual({ kind: 'resolved', providerMessageId: 'gmail-native-1', providerThreadId: 'thread-2', source: 'local_sibling' });
  });
  it('refuses an ambiguous local sibling match', async () => {
    const db = client([{ provider_message_id: 'one', provider_thread_id: 't1' }, { provider_message_id: 'two', provider_thread_id: 't2' }]);
    await expect(resolveGmailMessageIdentity(db, API, { messageId: 'legacy-row', accountId: 'account-1', rfcMessageId: '<rfc@example.test>' })).resolves.toEqual({ kind: 'ambiguous' });
  });
  it('uses bounded rfc822msgid search only after no local sibling exists', async () => {
    const db = client([]);
    provider.list.mockResolvedValueOnce({ messages: [{ id: 'gmail-remote-1', threadId: 'thread-3' }], nextPageToken: null });
    provider.get.mockResolvedValueOnce({ id: 'gmail-remote-1' });
    provider.project.mockReturnValueOnce({ providerMessageId: 'gmail-remote-1', providerThreadId: 'thread-3', messageId: '<rfc@example.test>', fromEmail: 'sender@example.test', subject: 'Topic', date: '2026-09-16T16:37:00Z' });
    await expect(resolveGmailMessageIdentity(db, API, { messageId: 'legacy-row', accountId: 'account-1', rfcMessageId: '<rfc@example.test>', fromEmail: 'sender@example.test', subject: 'Topic', date: '2026-09-16T16:37:00Z' })).resolves.toEqual({ kind: 'resolved', providerMessageId: 'gmail-remote-1', providerThreadId: 'thread-3', source: 'gmail_search' });
    expect(provider.list).toHaveBeenCalledWith(API, expect.objectContaining({ q: 'rfc822msgid:<rfc@example.test>', includeSpamTrash: true }));
  });
  it('never chooses one result from an ambiguous Gmail search', async () => {
    const db = client([]);
    provider.list.mockResolvedValueOnce({ messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: null });
    provider.get.mockResolvedValue({ id: 'x' });
    provider.project.mockReturnValueOnce({ providerMessageId: 'a', providerThreadId: 'ta', messageId: '<same@example.test>', fromEmail: null, subject: null, date: null }).mockReturnValueOnce({ providerMessageId: 'b', providerThreadId: 'tb', messageId: '<same@example.test>', fromEmail: null, subject: null, date: null });
    await expect(resolveGmailMessageIdentity(db, API, { messageId: 'legacy-row', accountId: 'account-1', rfcMessageId: '<same@example.test>' })).resolves.toEqual({ kind: 'ambiguous' });
  });
});
