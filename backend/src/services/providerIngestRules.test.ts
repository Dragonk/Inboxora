import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The provider ingest hook (MAIL-01, step 3): the block list runs over the INBOX rows a native synchronisation
 * just stored, through the provider port. Before this, a blocked sender's mail was stored and left in the inbox
 * on a Gmail or Microsoft account, because only the IMAP path ran the engine.
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
vi.mock('./providers/google/gmailMailMove.js', () => ({ moveGmailMessageToLabel: vi.fn() }));
vi.mock('./providers/google/gmailMailMutations.js', () => ({ deleteGmailMessagePermanently: vi.fn() }));
const { deleteGmailMessagePermanently } = vi.mocked(await import('./providers/google/gmailMailMutations.js'));
vi.mock('./providers/microsoft/graphMailMove.js', () => ({
  moveGraphMessageToFolder: vi.fn(),
  deleteGraphMessagePermanently: vi.fn(),
}));

const { query } = vi.mocked(await import('./db.js'));
const { resolveTrashFolder, resolveAllTrashPaths, getDeleteStrategy } = vi.mocked(await import('../utils/mailUtils.js'));
const { moveGmailMessageToLabel } = vi.mocked(await import('./providers/google/gmailMailMove.js'));
import { applyIngestRulesToRows } from './providerIngestRules.js';

const account = {
  id: 'acc-1', user_id: 'user-1', mail_transport: 'gmail_api', provider_connection_id: 'conn-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveTrashFolder.mockResolvedValue('Trash');
  resolveAllTrashPaths.mockResolvedValue(new Set(['Trash']));
  getDeleteStrategy.mockReturnValue({ action: 'move', destination: 'Trash' });
});

describe('the provider ingest block list', () => {
  it('moves a blocked sender’s freshly stored inbox message through the provider', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT email_address FROM block_list')) return { rows: [{ email_address: 'blocked@example.com' }] } as never;
      if (sql.includes('SELECT id, uid, folder, from_email, is_read')) {
        return { rows: [{ id: 'row-1', uid: 77, folder: 'INBOX', from_email: 'blocked@example.com', is_read: false }] } as never;
      }
      // The port resolves the row the engine addressed by uid to the provider's own id.
      if (sql.includes('SELECT id, provider_message_id FROM messages')) {
        return { rows: [{ id: 'row-1', provider_message_id: 'provider-1' }] } as never;
      }
      return { rows: [] } as never;
    });
    moveGmailMessageToLabel.mockResolvedValue({ moved: true, folder: 'Trash' });

    const outcome = await applyIngestRulesToRows({
      userId: 'user-1', connectionId: 'conn-1', account, folder: 'INBOX', rowIds: ['row-1'], providerName: 'Gmail',
    });

    expect(outcome).toEqual({ considered: 1, blocked: 1, ruled: 0, rulesSkipped: true });
    // The block list reached the provider: the message was moved to the account's trash by its provider id, which
    // the port resolved from the row the engine addressed by uid.
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM messages'), [['row-1'], 'acc-1', 'INBOX']);
    expect(moveGmailMessageToLabel).toHaveBeenCalledWith(expect.objectContaining({
      providerMessageId: 'provider-1', destinationPath: 'Trash', sourcePath: 'INBOX',
    }));
  });

  it('leaves an unblocked sender’s message in place', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT email_address FROM block_list')) return { rows: [] } as never;
      if (sql.includes('SELECT id, uid, folder, from_email, is_read')) {
        return { rows: [{ id: 'row-1', uid: 77, folder: 'INBOX', from_email: 'friend@example.com', is_read: false }] } as never;
      }
      return { rows: [] } as never;
    });

    const outcome = await applyIngestRulesToRows({
      userId: 'user-1', connectionId: 'conn-1', account, folder: 'INBOX', rowIds: ['row-1'], providerName: 'Gmail',
    });

    expect(outcome).toEqual({ considered: 1, blocked: 0, ruled: 0, rulesSkipped: true });
    expect(moveGmailMessageToLabel).not.toHaveBeenCalled();
  });

  it('does not run the rules while the installation has not turned them on for native accounts', async () => {
    // MAIL-01: unlike the block list, the rules are opt-in here. A global rule can delete mail, and applying it to
    // a native account for the first time after an upgrade is a destructive change nobody asked for.
    delete process.env.PROVIDER_NATIVE_RULES;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT email_address FROM block_list')) return { rows: [] } as never;
      if (sql.includes('SELECT id, uid, folder, from_email, is_read')) {
        return { rows: [{ id: 'row-1', uid: 77, folder: 'INBOX', from_email: 'news@example.test', is_read: false }] } as never;
      }
      if (sql.includes('FROM inbox_rules')) {
        return { rows: [{ id: 'rule-1', condition_logic: 'AND', conditions: [{ field: 'from', operator: 'contains', value: 'news@example.com' }], actions: [{ type: 'delete' }] }] } as never;
      }
      return { rows: [] } as never;
    });

    const outcome = await applyIngestRulesToRows({
      userId: 'user-1', connectionId: 'conn-1', account, folder: 'INBOX', rowIds: ['row-1'], providerName: 'Gmail',
    });

    expect(outcome).toEqual({ considered: 1, blocked: 0, ruled: 0, rulesSkipped: true });
    // The rule's delete never reached the provider.
    expect(deleteGmailMessagePermanently).not.toHaveBeenCalled();
  });

  it('runs a user’s rule on the freshly stored inbox mail, through the provider', async () => {
    // MAIL-01: a rule never ran for a native account. It does now, and its move reaches Gmail through the same
    // port the block list uses — the engine itself still knows nothing about transports.
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT email_address FROM block_list')) return { rows: [] } as never;
      if (sql.includes('SELECT id, uid, folder, from_email, is_read')) {
        return { rows: [{ id: 'row-1', uid: 77, folder: 'INBOX', from_email: 'news@example.com', is_read: false }] } as never;
      }
      if (sql.includes('FROM inbox_rules')) {
        return { rows: [{ id: 'rule-1', condition_logic: 'AND', conditions: [{ field: 'from', operator: 'contains', value: 'news@example.com' }], actions: [{ type: 'move', value: 'Archive' }] }] } as never;
      }
      if (sql.includes('SELECT id, provider_message_id FROM messages')) {
        return { rows: [{ id: 'row-1', provider_message_id: 'provider-1' }] } as never;
      }
      return { rows: [] } as never;
    });
    moveGmailMessageToLabel.mockResolvedValue({ moved: true, folder: 'Archive' });

    process.env.PROVIDER_NATIVE_RULES = '1';
    const outcome = await applyIngestRulesToRows({
      userId: 'user-1', connectionId: 'conn-1', account, folder: 'INBOX', rowIds: ['row-1'], providerName: 'Gmail',
    });

    expect(outcome).toEqual({ considered: 1, blocked: 0, ruled: 1, rulesSkipped: false });
    expect(moveGmailMessageToLabel).toHaveBeenCalledWith(expect.objectContaining({
      providerMessageId: 'provider-1', destinationPath: 'Archive',
    }));
  });

  it('passes persisted provider headers to a native inbox rule', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT email_address FROM block_list')) return { rows: [] } as never;
      if (sql.includes('SELECT id, uid, folder, from_email, is_read')) {
        return { rows: [{
          id: 'row-1', uid: 77, folder: 'INBOX', from_email: 'news@example.com', from_name: 'News',
          subject: 'Invoice', to_addresses: [{ address: 'me@example.com' }], has_attachments: true,
          is_read: false, parsed_headers: { 'list-id': 'invoices.example.com' },
        }] } as never;
      }
      if (sql.includes('FROM inbox_rules')) {
        return { rows: [{ id: 'rule-1', condition_logic: 'AND', conditions: [{ field: 'header', headerName: 'List-Id', operator: 'contains', value: 'invoices' }], actions: [{ type: 'move', value: 'Archive' }] }] } as never;
      }
      if (sql.includes('SELECT id, provider_message_id FROM messages')) return { rows: [{ id: 'row-1', provider_message_id: 'provider-1' }] } as never;
      return { rows: [] } as never;
    });
    moveGmailMessageToLabel.mockResolvedValue({ moved: true, folder: 'Archive' });
    process.env.PROVIDER_NATIVE_RULES = '1';

    const outcome = await applyIngestRulesToRows({
      userId: 'user-1', connectionId: 'conn-1', account, folder: 'INBOX', rowIds: ['row-1'], providerName: 'Gmail',
    });

    expect(outcome).toMatchObject({ ruled: 1, rulesSkipped: false });
    expect(moveGmailMessageToLabel).toHaveBeenCalledWith(expect.objectContaining({ providerMessageId: 'provider-1' }));
  });

  it('durably defers missing native body data before any rule action', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, uid, folder, from_email, is_read')) {
        return { rows: [{ id: 'row-1', uid: 77, folder: 'INBOX', from_email: 'news@example.com', is_read: false, body_text: null, parsed_headers: { subject: 'Report' } }] } as never;
      }
      if (sql.includes('FROM inbox_rules')) {
        return { rows: [{ id: 'rule-1', conditions: [{ field: 'body', operator: 'not_contains', value: 'unsubscribe' }], actions: [{ type: 'move', value: 'Archive' }] }] } as never;
      }
      if (sql.includes('INSERT INTO provider_rule_deferred_messages')) return { rows: [] } as never;
      return { rows: [] } as never;
    });
    process.env.PROVIDER_NATIVE_RULES = '1';

    const outcome = await applyIngestRulesToRows({
      userId: 'user-1', connectionId: 'conn-1', account, folder: 'INBOX', rowIds: ['row-1'], providerName: 'Gmail',
    });

    expect(outcome).toEqual({ considered: 1, blocked: 0, ruled: 0, rulesSkipped: false });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO provider_rule_deferred_messages'), expect.arrayContaining(['row-1', 'acc-1', true, false]));
    expect(moveGmailMessageToLabel).not.toHaveBeenCalled();
  });

  it('does nothing when the run stored no inbox rows', async () => {
    const outcome = await applyIngestRulesToRows({
      userId: 'user-1', connectionId: 'conn-1', account, folder: 'INBOX', rowIds: [], providerName: 'Gmail',
    });
    expect(outcome).toEqual({ considered: 0, blocked: 0, ruled: 0, rulesSkipped: false });
    expect(query).not.toHaveBeenCalled();
  });
});
