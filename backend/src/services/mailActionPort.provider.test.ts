import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The provider implementation of the mail-action port (MAIL-01).
 *
 * The engine addresses a message by its IMAP-shaped `uid` and folder; a provider message has no such identity, so
 * the port resolves the local row from that pair and then acts by the provider's own id — through the move,
 * delete and flag services that already exist and already run on the mutation journal.
 */

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./providers/google/gmailMailMove.js', () => ({ moveGmailMessageToLabel: vi.fn() }));
vi.mock('./providers/google/gmailMailMutations.js', () => ({ deleteGmailMessagePermanently: vi.fn() }));
vi.mock('./providers/microsoft/graphMailMove.js', () => ({
  moveGraphMessageToFolder: vi.fn(),
  deleteGraphMessagePermanently: vi.fn(),
}));
vi.mock('./providerMailFlagWrite.js', () => ({ pushGmailMessageFlag: vi.fn(), pushGraphMessageFlag: vi.fn() }));
vi.mock('./providerAuthService.js', () => ({
  googleConfigFromEnv: () => ({ clientId: 'google-client' }),
  microsoftConfigFromEnv: () => ({ clientId: 'ms-client' }),
}));

const { query } = vi.mocked(await import('./db.js'));
const { moveGmailMessageToLabel } = vi.mocked(await import('./providers/google/gmailMailMove.js'));
const { deleteGmailMessagePermanently } = vi.mocked(await import('./providers/google/gmailMailMutations.js'));
const { moveGraphMessageToFolder, deleteGraphMessagePermanently } = vi.mocked(await import('./providers/microsoft/graphMailMove.js'));
const { pushGmailMessageFlag, pushGraphMessageFlag } = vi.mocked(await import('./providerMailFlagWrite.js'));
import { providerMailActionPort } from './mailActionPort.js';
import type { EmailAccountRow } from './imapManager.js';

const gmailAccount = { id: 'acc-1', mail_transport: 'gmail_api', provider_connection_id: 'conn-1' } as EmailAccountRow;
const graphAccount = { id: 'acc-1', mail_transport: 'microsoft_graph', provider_connection_id: 'conn-1' } as EmailAccountRow;

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows: [{ id: 'msg-row-1', provider_message_id: 'provider-1' }] } as never);
});

describe('the provider mail-action port', () => {
  it('moves a Gmail message by its provider id, resolved from the uid the engine passes', async () => {
    moveGmailMessageToLabel.mockResolvedValue({ moved: true, folder: 'Archive' });

    const result = await providerMailActionPort({ userId: 'user-1', account: gmailAccount, connectionId: 'conn-1' })
      .bulkMoveMessages(gmailAccount, [42], 'INBOX', 'Archive');

    expect(result.failed).toEqual([]);
    expect(result.succeeded).toEqual([42]);
    // The engine's `uid` was resolved to the local row, and the move went through the existing service.
    expect(moveGmailMessageToLabel).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'msg-row-1', providerMessageId: 'provider-1', destinationPath: 'Archive', sourcePath: 'INBOX',
    }));
    // The local row follows the move.
    expect(query).toHaveBeenCalledWith('UPDATE messages SET folder = $1, synced_at = NOW() WHERE id = $2', ['Archive', 'msg-row-1']);
  });

  it('carries Graph’s new message id after a move, so the next sync cannot duplicate the message', async () => {
    // Graph reassigns an item's id when it moves; a local row still holding the old id would look like a message
    // that vanished and a different one that arrived.
    moveGraphMessageToFolder.mockResolvedValue({ moved: true, newProviderMessageId: 'provider-2', newUid: '7' });

    const result = await providerMailActionPort({ userId: 'user-1', account: graphAccount, connectionId: 'conn-1' })
      .bulkMoveMessages(graphAccount, [42], 'INBOX', 'Archive');

    expect(result.failed).toEqual([]);
    expect(query).toHaveBeenCalledWith('UPDATE messages SET provider_message_id = $1 WHERE id = $2', ['provider-2', 'msg-row-1']);
  });

  it('reports a message it cannot resolve as failed, so the engine keeps it', async () => {
    // An unresolvable row must not be reported as moved: the block list would drop the message from its own
    // pending set while nothing had happened at the provider.
    query.mockResolvedValue({ rows: [] } as never);

    const result = await providerMailActionPort({ userId: 'user-1', account: gmailAccount, connectionId: 'conn-1' })
      .bulkMoveMessages(gmailAccount, [42], 'INBOX', 'Archive');

    expect(result.failed).toEqual([42]);
    expect(result.succeeded).toEqual([]);
    expect(moveGmailMessageToLabel).not.toHaveBeenCalled();
  });

  it('treats the block list’s expunge as the provider’s own delete, not as a flag', async () => {
    deleteGraphMessagePermanently.mockResolvedValue({ deleted: true });
    deleteGmailMessagePermanently.mockResolvedValue({ deleted: true });

    const graphDeleted = await providerMailActionPort({ userId: 'user-1', account: graphAccount, connectionId: 'conn-1' })
      .setFlag(graphAccount, 42, 'INBOX', '\\Deleted', true);

    expect(graphDeleted).toBe(true);
    expect(deleteGraphMessagePermanently).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'msg-row-1', providerMessageId: 'provider-1',
    }));
    expect(pushGraphMessageFlag).not.toHaveBeenCalled();

    // The same action means the same thing on Gmail.
    const gmailDeleted = await providerMailActionPort({ userId: 'user-1', account: gmailAccount, connectionId: 'conn-1' })
      .setFlag(gmailAccount, 42, 'INBOX', '\\Deleted', true);

    expect(gmailDeleted).toBe(true);
    expect(deleteGmailMessagePermanently).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'msg-row-1', providerMessageId: 'provider-1',
    }));
    expect(pushGmailMessageFlag).not.toHaveBeenCalled();
  });

  it('writes a read/starred flag through the provider flag service', async () => {
    pushGmailMessageFlag.mockResolvedValue({ status: 'confirmed' });

    const written = await providerMailActionPort({ userId: 'user-1', account: gmailAccount, connectionId: 'conn-1' })
      .setFlag(gmailAccount, 42, 'INBOX', '\\Seen', true);

    expect(written).toBe(true);
    expect(pushGmailMessageFlag).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'msg-row-1', providerMessageId: 'provider-1', flag: '\\Seen', value: true,
    }));
  });

  it('never hands a provider change to the IMAP flag-push reconciler', async () => {
    // The reconciler writes over IMAP; queuing a provider change there would corrupt whichever account shares the
    // id. A provider write schedules its own retry on the journal instead, so this is deliberately a no-op.
    const port = providerMailActionPort({ userId: 'user-1', account: gmailAccount, connectionId: 'conn-1' });
    expect(() => port._enqueueFlagPush('acc-1', 'msg-row-1', '\\Seen', true)).not.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
