import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({
  resolveArchiveFolder: vi.fn(), isAllMailFolder: vi.fn(), resolveTrashFolder: vi.fn(),
  resolveAllTrashPaths: vi.fn(), getDeleteStrategy: vi.fn(), adjustFolderCounts: vi.fn(),
}));
vi.mock('./ruleForwarder.js', () => ({ forwardRuleMessage: vi.fn() }));

const { query } = vi.mocked(await import('./db.js'));
const { applyInboxRules } = await import('./inboxRules.js');
import { mockImapManager } from '../test/imapClient.js';

const account = { id: 'acc-1', user_id: 'user-1', folder_mappings: {} };
const port = mockImapManager({
  bulkMoveMessages: vi.fn(), setFlag: vi.fn(), _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(),
});
const message = { id: 'msg-1', uid: '100', folder: 'INBOX', fromEmail: 'sender@example.com', is_read: false };

beforeEach(() => { vi.clearAllMocks(); });

describe('provider rule unknown-field safety', () => {
  it('does not match a negative body condition when body hydration is unavailable', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'rule-1', condition_logic: 'AND', conditions: [{ field: 'body', operator: 'not_contains', value: 'invoice' }], actions: [{ type: 'move', value: 'INBOX/Processed' }] }] });
    query.mockResolvedValueOnce({ rows: [] });

    const result = await applyInboxRules([message], account, port);

    expect(result.remaining).toHaveLength(1);
    expect(port.bulkMoveMessages).not.toHaveBeenCalled();
  });

  it('does not match a negative sender condition when the sender name is not hydrated', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'rule-1', condition_logic: 'AND', conditions: [{ field: 'from', operator: 'not_contains', value: 'blocked' }], actions: [{ type: 'delete' }] }] });

    const result = await applyInboxRules([message], account, port);

    expect(result.remaining).toHaveLength(1);
    expect(port.bulkMoveMessages).not.toHaveBeenCalled();
  });
});
