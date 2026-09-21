import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The ingest rules run against a **seam**, not against `ImapManager` (MAIL-01).
 *
 * The rules and the block list were written against the IMAP manager itself — moving and flagging by `uid` and
 * folder path — so they could only ever run for an IMAP account. These cases pin the seam: the engine runs with
 * a plain object that is not an `ImapManager` at all, and `imapMailActionPort` hands the manager through it
 * unchanged for the IMAP path.
 */

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({
  resolveArchiveFolder: vi.fn(),
  isAllMailFolder: vi.fn(),
  resolveTrashFolder: vi.fn(),
  resolveAllTrashPaths: vi.fn(),
  getDeleteStrategy: vi.fn(),
  adjustFolderCounts: vi.fn(),
}));
vi.mock('./ruleForwarder.js', () => ({ forwardRuleMessage: vi.fn() }));

const { query } = vi.mocked(await import('./db.js'));
const { resolveTrashFolder, resolveAllTrashPaths, getDeleteStrategy } = vi.mocked(await import('../utils/mailUtils.js'));
import { applyBlockList } from './inboxRules.js';
import { imapMailActionPort } from './mailActionPort.js';
import type { MailActionPort } from './mailActionPort.js';
import { mockImapManager } from '../test/imapClient.js';

const account = { id: 'acc-1', user_id: 'user-1', folder_mappings: {} };

const mkMsg = (overrides: Record<string, unknown> = {}) => ({
  id: 'msg-1', uid: 100, folder: 'INBOX', account_id: 'acc-1',
  fromEmail: 'blocked@example.com', fromName: 'Blocked',
  to: [], subject: 'Test', is_read: false, hasAttachments: false,
  parsedHeaders: {},
  ...overrides,
});

/** A port that is deliberately **not** an ImapManager: a plain object with the members the engine needs. */
function fakePort(record: { moves: Array<{ uid: unknown; from: string; to: string }>; flags: string[] }): MailActionPort {
  return {
    _guardMoveUid: () => {},
    _unguardMoveUid: () => {},
    _enqueueFlagPush: () => {},
    bulkMoveMessages: async (_account, uids, from, to) => {
      record.moves.push({ uid: uids[0], from, to });
      return { uidMap: new Map([[100, 200]]), succeeded: [uids[0]], failed: [] };
    },
    setFlag: async () => { record.flags.push('setFlag'); return true; },
    fetchMessageBody: async () => ({ text: 'body' }),
    fetchMultipleAttachments: async () => new Map(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows: [{ email_address: 'blocked@example.com' }] } as never);
  resolveTrashFolder.mockResolvedValue('Trash');
  resolveAllTrashPaths.mockResolvedValue(new Set(['Trash']));
  getDeleteStrategy.mockReturnValue({ action: 'move', destination: 'Trash' });
});

describe('the ingest rules take a message-action port', () => {
  it('moves a blocked sender’s message through a port that is not an ImapManager', async () => {
    const record = { moves: [] as Array<{ uid: unknown; from: string; to: string }>, flags: [] as string[] };

    const remaining = await applyBlockList([mkMsg()], account, fakePort(record));

    // The blocked message left the inbox **through the port**, which is the whole point: a provider port can be
    // substituted without the engine knowing what a transport is.
    expect(remaining).toHaveLength(0);
    expect(record.moves).toEqual([{ uid: 100, from: 'INBOX', to: 'Trash' }]);
  });

  it('leaves a message from an unblocked sender alone', async () => {
    const record = { moves: [] as Array<{ uid: unknown; from: string; to: string }>, flags: [] as string[] };

    const remaining = await applyBlockList([mkMsg({ fromEmail: 'friend@example.com' })], account, fakePort(record));

    expect(remaining).toHaveLength(1);
    expect(record.moves).toEqual([]);
  });

  it('hands the IMAP manager through the port unchanged', () => {
    // Structural: the manager already satisfies the port, which is why wiring it in changed no IMAP call site.
    const manager = mockImapManager({});
    const port = imapMailActionPort(manager);
    expect(port._guardMoveUid).toBe(manager._guardMoveUid);
    expect(port.bulkMoveMessages).toBe(manager.bulkMoveMessages);
    expect(port.setFlag).toBe(manager.setFlag);
    expect(port.fetchMessageBody).toBe(manager.fetchMessageBody);
    expect(port.fetchMultipleAttachments).toBe(manager.fetchMultipleAttachments);
  });
});
