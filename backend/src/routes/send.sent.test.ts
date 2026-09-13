import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: vi.fn() }));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));

import { ensureServerAutoSavedSentCopy } from './send.js';

const account = { id: 'account-1', email_address: 'me@example.com' };
const sentMeta = { messageId: '<message@example.com>', subject: 'Test' };
const rawMessage = Buffer.from('Message-ID: <message@example.com>\r\n\r\nHello');

function createManager({ foundUid = null, appendResult = { uid: 99 } } = {}) {
  return {
    findUidByMessageId: vi.fn().mockResolvedValue(foundUid),
    findSentMessageByMessageId: vi.fn().mockResolvedValue(
      foundUid ? { state: 'found', uid: foundUid } : { state: 'missing' }
    ),
    appendToSent: vi.fn().mockResolvedValue(appendResult),
    upsertSentMessageRecord: vi.fn().mockResolvedValue(),
  };
}

describe('ensureServerAutoSavedSentCopy', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not append a duplicate when the provider exposes its own Sent copy', async () => {
    const manager = createManager({ foundUid: 42 });

    const result = await ensureServerAutoSavedSentCopy({
      account,
      sentFolder: 'Sent',
      messageId: sentMeta.messageId,
      rawMessage,
      sentMeta,
      manager,
      delays: [0],
      sleep: vi.fn().mockResolvedValue(),
    });

    expect(result).toEqual({ saved: true, appended: false });
    expect(manager.appendToSent).not.toHaveBeenCalled();
    expect(manager.upsertSentMessageRecord).toHaveBeenCalledWith(account, 'Sent', 42, sentMeta);
  });

  it('appends exactly one CRLF MIME copy after provider autosave never appears', async () => {
    const manager = createManager();

    const result = await ensureServerAutoSavedSentCopy({
      account,
      sentFolder: 'Sent',
      messageId: sentMeta.messageId,
      rawMessage,
      sentMeta,
      manager,
      delays: [0, 0],
      sleep: vi.fn().mockResolvedValue(),
    });

    expect(result).toEqual({ saved: true, appended: true });
    expect(manager.findSentMessageByMessageId).toHaveBeenCalledTimes(3);
    expect(manager.appendToSent).toHaveBeenCalledTimes(1);
    expect(manager.appendToSent).toHaveBeenCalledWith(account, 'Sent', rawMessage);
    expect(manager.upsertSentMessageRecord).toHaveBeenCalledWith(account, 'Sent', 99, sentMeta);
  });

  it('reports the missing remote copy when the fallback APPEND fails', async () => {
    const manager = createManager();
    manager.appendToSent.mockRejectedValue(new Error('IMAP unavailable'));

    const result = await ensureServerAutoSavedSentCopy({
      account,
      sentFolder: 'Sent',
      messageId: sentMeta.messageId,
      rawMessage,
      sentMeta,
      manager,
      delays: [0],
      sleep: vi.fn().mockResolvedValue(),
    });

    expect(result).toEqual({ saved: false, appended: true });
    expect(manager.upsertSentMessageRecord).not.toHaveBeenCalled();
  });

  it('does not risk a duplicate APPEND when Sent-copy verification is unavailable', async () => {
    const manager = createManager();
    manager.findSentMessageByMessageId.mockRejectedValue(new Error('IMAP unavailable'));

    const result = await ensureServerAutoSavedSentCopy({
      account,
      sentFolder: 'Sent',
      messageId: sentMeta.messageId,
      rawMessage,
      sentMeta,
      manager,
      delays: [0],
      sleep: vi.fn().mockResolvedValue(),
    });

    expect(result).toEqual({ saved: false, appended: false });
    expect(manager.appendToSent).not.toHaveBeenCalled();
  });

  it('does not append when Message-ID lookup is ambiguous', async () => {
    const manager = createManager();
    manager.findSentMessageByMessageId.mockResolvedValue({ state: 'ambiguous' });

    const result = await ensureServerAutoSavedSentCopy({
      account,
      sentFolder: 'Sent',
      messageId: sentMeta.messageId,
      rawMessage,
      sentMeta,
      manager,
      delays: [0],
      sleep: vi.fn().mockResolvedValue(),
    });

    expect(result).toEqual({ saved: false, appended: false });
    expect(manager.appendToSent).not.toHaveBeenCalled();
  });

  it('performs a final lookup before APPEND when the provider copy appears late', async () => {
    const manager = createManager();
    manager.findSentMessageByMessageId
      .mockResolvedValueOnce({ state: 'missing' })
      .mockResolvedValueOnce({ state: 'found', uid: 73 });

    const result = await ensureServerAutoSavedSentCopy({
      account,
      sentFolder: 'Sent',
      messageId: sentMeta.messageId,
      rawMessage,
      sentMeta,
      manager,
      delays: [0],
      sleep: vi.fn().mockResolvedValue(),
    });

    expect(result).toEqual({ saved: true, appended: false });
    expect(manager.appendToSent).not.toHaveBeenCalled();
    expect(manager.upsertSentMessageRecord).toHaveBeenCalledWith(account, 'Sent', 73, sentMeta);
  });
});
