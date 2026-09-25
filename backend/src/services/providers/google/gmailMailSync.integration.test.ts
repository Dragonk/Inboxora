// Real PostgreSQL tests for the Gmail API label/message vertical (P08). The
// provider is faked at the HTTP boundary; label projection, the collection links,
// the history cursor, the baseline checkpoint, the lease and the message rows are
// real, and the assertions read the persisted projection exactly as the mail list
// would.
//
// Run with:
//   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=inboxora_gmail_gate DB_USER=mailflow_test DB_PASSWORD=mailflow_test \
//     npx vitest run src/services/providers/google/gmailMailSync.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db.js';
import {
  GOOGLE_GRANT_AUDIENCE,
  GOOGLE_ISSUER,
  storeOAuthGrant,
  upsertProviderConnection,
} from '../../providerAuthService.js';
import { acquireSyncLease, ensureSyncState } from '../../syncCoordinator.js';
import { listMessages } from '../../messageService.js';
import { labelMembershipReport } from '../../providerLabelMembership.js';
import {
  gmailLabelIdForPath,
  syncGmailMailLabels,
  syncGmailMailLabelsForAccount,
  syncGmailMailMessagesForAccount,
} from './gmailMailSync.js';

/**
 * The provider move the block list performs, mocked at **its own** boundary.
 *
 * `moveGmailMessageToLabel` builds its own Gmail client, so the HTTP fake this suite uses for the synchronisation
 * cannot intercept it. Mocking it here still lets the case prove what matters: the engine ran on a real
 * synchronisation's rows, resolved the right message and asked the provider for the right destination. The mock
 * also **flips the mailbox state** the HTTP fake reports, because a real move changes it — and a fake that keeps
 * listing the message under INBOX would have the synchronisation's own reconcile put it back.
 */
const movedToTrash = vi.hoisted(() => ({ value: false }));
const moveGmailMessageToLabelMock = vi.hoisted(() => vi.fn(async () => {
  movedToTrash.value = true;
  return { moved: true as const, folder: 'Trash' };
}));
vi.mock('./gmailMailMove.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./gmailMailMove.js')>()),
  moveGmailMessageToLabel: moveGmailMessageToLabelMock,
}));

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-0000000005c1';
const ACCOUNT_ID = '00000000-0000-0000-0000-0000000005c2';
const CONFIG = { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://inboxora.example/oauth/google/callback' };
const originalKey = process.env.ENCRYPTION_KEY;

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body } as Response;
}

interface Route {
  match: RegExp;
  handle: (url: URL) => Response | Promise<Response>;
}

/**
 * A fake Gmail API routed by path, because one sync run interleaves label, profile,
 * list, thread and history calls and a call-order fake would encode an ordering the
 * adapter is deliberately free to choose.
 */
function fakeGmail(routes: Route[]): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = async (input: string): Promise<Response> => {
    const raw = String(input);
    urls.push(raw);
    const url = new URL(raw);
    const route = routes.find(candidate => candidate.match.test(url.pathname));
    if (!route) throw new Error(`Unexpected Gmail call: ${raw}`);
    return route.handle(url);
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, urls };
}

async function autocommit<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function seedConnection(): Promise<string> {
  return inTransaction(async client => {
    const connectionId = await upsertProviderConnection(client, {
      userId: USER_ID, provider: 'google', issuer: GOOGLE_ISSUER, subject: 'google-sub-mail',
    });
    await storeOAuthGrant(client, {
      connectionId,
      audience: GOOGLE_GRANT_AUDIENCE,
      accessToken: 'google-access-valid',
      refreshToken: 'google-refresh-1',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      clientIdAtIssue: CONFIG.clientId,
    });
    await client.query(
      `INSERT INTO email_accounts (id, user_id, name, email_address, protocol, imap_host, mail_transport, provider_connection_id)
       VALUES ($1, $2, 'Gmail', 'sam@gmail.test', 'imap', 'imap.gmail.com', 'gmail_api', $3)
       ON CONFLICT (id) DO UPDATE SET provider_connection_id = EXCLUDED.provider_connection_id, mail_transport = 'gmail_api'`,
      [ACCOUNT_ID, USER_ID, connectionId],
    );
    return connectionId;
  });
}

interface StoredMessage {
  provider_message_id: string;
  folder: string;
  thread_id: string | null;
  thread_key: string;
  provider_thread_id: string | null;
  provider_labels: string[] | null;
  subject: string | null;
  is_read: boolean;
  is_starred: boolean;
  has_attachments: boolean;
}

async function storedMessages(): Promise<StoredMessage[]> {
  const result = await autocommit(client => client.query<StoredMessage>(
    `SELECT provider_message_id, folder, thread_id, thread_key, provider_thread_id, provider_labels,
            subject, is_read, is_starred, has_attachments
       FROM messages WHERE account_id = $1 ORDER BY provider_message_id`,
    [ACCOUNT_ID],
  ));
  return result.rows;
}

async function storedFolders(): Promise<Array<{ path: string; name: string; special_use: string | null }>> {
  const result = await autocommit(client => client.query<{ path: string; name: string; special_use: string | null }>(
    'SELECT path, name, special_use FROM folders WHERE account_id = $1 ORDER BY path', [ACCOUNT_ID],
  ));
  return result.rows;
}

const LABELS = {
  labels: [
    { id: 'INBOX', name: 'Inbox', type: 'system', messagesTotal: 2, messagesUnread: 1 },
    { id: 'SENT', name: 'Sent', type: 'system', messagesTotal: 0, messagesUnread: 0 },
    { id: 'DRAFT', name: 'Drafts', type: 'system' },
    { id: 'TRASH', name: 'Trash', type: 'system' },
    { id: 'SPAM', name: 'Spam', type: 'system' },
    { id: 'STARRED', name: 'Starred', type: 'system' },
    { id: 'IMPORTANT', name: 'Important', type: 'system' },
    { id: 'UNREAD', name: 'Unread', type: 'system' },
    { id: 'Label_1', name: 'Work', type: 'user', messagesTotal: 0, messagesUnread: 0 },
  ],
};

// The same account after `Work` was deleted and `Private` created: every other label
// is unchanged, so the only reconciliation is the one under test.
const labelless = {
  labels: [
    ...LABELS.labels.filter(label => label.id !== 'Label_1'),
    { id: 'Label_2', name: 'Private', type: 'user', messagesTotal: 0, messagesUnread: 0 },
  ],
};

function message(id: string, threadId: string, labelIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    id,
    threadId,
    labelIds,
    snippet: `snippet ${id}`,
    internalDate: String(Date.UTC(2026, 8, 1, 9, 0)),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: `${id}@example.test` },
        { name: 'To', value: 'me@example.test' },
        { name: 'Subject', value: `Subject ${id}` },
        { name: 'Message-ID', value: `<${id}@example.test>` },
      ],
    },
    ...overrides,
  };
}

describeOrSkip('Gmail API label and message ingest (PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'gmail-api-user') ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    ));
  });

  afterAll(async () => {
    await autocommit(client => client.query('DELETE FROM users WHERE id = $1', [USER_ID]));
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
  });

  beforeEach(async () => {
    moveGmailMessageToLabelMock.mockClear();
    await autocommit(async client => {
      await client.query('DELETE FROM provider_connections WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM email_accounts WHERE user_id = $1', [USER_ID]);
    });
  });

  it('projects labels into the local model and links each by its immutable id', async () => {
    const connectionId = await seedConnection();
    const provider = fakeGmail([{ match: /\/labels$/, handle: () => json(LABELS) }]);

    const results = await syncGmailMailLabels({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ accountId: ACCOUNT_ID, labels: 6, created: 6, updated: 0, renamed: 0 });

    // The system mailboxes keep the canonical local paths the rest of the
    // application compares against; STARRED/IMPORTANT/UNREAD are not folders.
    expect(await storedFolders()).toEqual([
      { path: 'Drafts', name: 'Drafts', special_use: '\\Drafts' },
      { path: 'INBOX', name: 'Inbox', special_use: '\\Inbox' },
      { path: 'Sent', name: 'Sent', special_use: '\\Sent' },
      { path: 'Spam', name: 'Spam', special_use: '\\Junk' },
      { path: 'Trash', name: 'Trash', special_use: '\\Trash' },
      { path: 'Work', name: 'Work', special_use: null },
    ]);

    const links = await autocommit(client => client.query<{ remote_id: string; local_folder_id: string | null }>(
      `SELECT remote_id, local_folder_id FROM integration_collections
        WHERE connection_id = $1 AND kind = 'mail_label' ORDER BY remote_id`, [connectionId],
    ));
    expect(links.rows.map(row => row.remote_id)).toEqual(['DRAFT', 'INBOX', 'Label_1', 'SENT', 'SPAM', 'TRASH']);
    for (const row of links.rows) expect(row.local_folder_id).not.toBeNull();

    expect(await gmailLabelIdForPath({ connectionId, accountId: ACCOUNT_ID, path: 'Work' })).toBe('Label_1');
  });

  it('is idempotent and keeps a renamed label on the same local folder', async () => {
    const connectionId = await seedConnection();
    await syncGmailMailLabels({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeGmail([{ match: /\/labels$/, handle: () => json(LABELS) }]).fetchImpl });
    const first = await storedFolders();

    const second = await syncGmailMailLabels({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeGmail([{ match: /\/labels$/, handle: () => json(LABELS) }]).fetchImpl });
    expect(second[0]).toMatchObject({ created: 0, updated: 6 });
    expect(await storedFolders()).toEqual(first);

    // A rename is a display-name change on the same immutable id: the folder keeps
    // its identity and its messages, and only the path follows.
    await autocommit(client => client.query(
      `INSERT INTO messages (account_id, uid, folder, subject, provider_message_id, provider_labels)
       VALUES ($1, 42, 'Work', 'Report', 'm9', ARRAY['Label_1'])`, [ACCOUNT_ID],
    ));
    const renamed = { labels: LABELS.labels.map(label => label.id === 'Label_1' ? { ...label, name: 'Business' } : label) };
    const third = await syncGmailMailLabels({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeGmail([{ match: /\/labels$/, handle: () => json(renamed) }]).fetchImpl });
    expect(third[0]).toMatchObject({ renamed: 1, relocatedMessages: 1 });
    expect((await storedFolders()).map(row => row.path)).toContain('Business');
    expect((await storedMessages())[0]?.folder).toBe('Business');
  });

  it('re-homes the messages of a deleted label instead of dropping them', async () => {
    const connectionId = await seedConnection();
    await syncGmailMailLabels({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeGmail([{ match: /\/labels$/, handle: () => json(LABELS) }]).fetchImpl });

    // One message still carries another label; one is now archived; one never came
    // from the API and must be left alone.
    await autocommit(async client => {
      await client.query(
        `INSERT INTO messages (account_id, uid, folder, subject, provider_message_id, provider_labels)
         VALUES ($1, 11, 'Work', 'Still labelled', 'm1', ARRAY['Label_1','Label_2'])`, [ACCOUNT_ID]);
      await client.query(
        `INSERT INTO messages (account_id, uid, folder, subject, provider_message_id, provider_labels)
         VALUES ($1, 12, 'Work', 'Archived now', 'm2', ARRAY['STARRED'])`, [ACCOUNT_ID]);
      await client.query(
        `INSERT INTO messages (account_id, uid, folder, subject, provider_message_id)
         VALUES ($1, 13, 'Work', 'No label set', 'm3')`, [ACCOUNT_ID]);
    });

    const result = await syncGmailMailLabels({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeGmail([{ match: /\/labels$/, handle: () => json(labelless) }]).fetchImpl,
    });
    expect(result[0]).toMatchObject({ deleted: 1, relocatedMessages: 2 });

    const rows = await storedMessages();
    // `Work` is gone: the message that still had Private moved there, the archived
    // one left the local view, and the row with no label set was not guessed at.
    expect(rows.map(row => [row.provider_message_id, row.folder])).toEqual([
      ['m1', 'Private'],
      ['m3', 'Work'],
    ]);
    expect((await storedFolders()).map(row => row.path)).toEqual(['Drafts', 'INBOX', 'Private', 'Sent', 'Spam', 'Trash']);
    const links = await autocommit(client => client.query(
      `SELECT remote_id FROM integration_collections WHERE connection_id = $1 AND kind = 'mail_label'`, [connectionId]));
    expect(links.rows.map(row => row.remote_id).sort()).toEqual(['DRAFT', 'INBOX', 'Label_2', 'SENT', 'SPAM', 'TRASH']);
  });

  it('builds a baseline from the message list and stores the mailbox history cursor', async () => {
    const connectionId = await seedConnection();
    await syncGmailMailLabels({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeGmail([{ match: /\/labels$/, handle: () => json(LABELS) }]).fetchImpl });

    const inboxMessage = message('m1', 't1', ['UNREAD', 'INBOX']);
    const workMessage = message('m2', 't2', ['Label_1', 'STARRED'], {
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: 'Ana <ana@example.test>' },
          { name: 'To', value: 'me@example.test' },
          { name: 'Subject', value: 'Design doc' },
          { name: 'Message-ID', value: '<m2@example.test>' },
        ],
        parts: [{ partId: '1', mimeType: 'application/pdf', filename: 'design.pdf' }],
      },
    });

    const provider = fakeGmail([
      { match: /\/profile$/, handle: () => json({ historyId: '1000' }) },
      { match: /\/messages$/, handle: url => json(url.searchParams.get('labelIds') === 'INBOX'
        ? { messages: [{ id: 'm1', threadId: 't1' }] }
        : url.searchParams.get('labelIds') === 'Label_1'
          ? { messages: [{ id: 'm2', threadId: 't2' }] }
          : { messages: [] }) },
      { match: /\/threads\/t1$/, handle: () => json({ id: 't1', historyId: '1000', messages: [inboxMessage] }) },
      { match: /\/threads\/t2$/, handle: () => json({ id: 't2', historyId: '1000', messages: [workMessage] }) },
    ]);

    const result = await syncGmailMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: provider.fetchImpl,
    });
    expect(result).toMatchObject({ mode: 'baseline', fullSync: true, incomplete: false, created: 2, updated: 0, cursor: '1000' });

    const rows = await storedMessages();
    expect(rows.map(row => [row.provider_message_id, row.folder])).toEqual([['m1', 'INBOX'], ['m2', 'Work']]);
    expect(rows[0]).toMatchObject({
      thread_id: 'gmail:t1',
      thread_key: 'gmail:t1',
      provider_thread_id: 't1',
      provider_labels: ['UNREAD', 'INBOX'],
      subject: 'Subject m1',
      is_read: false,
      is_starred: false,
    });
    expect(rows[1]).toMatchObject({
      thread_key: 'gmail:t2',
      is_read: true,
      is_starred: true,
      has_attachments: true,
    });

    // MAIL-02: the message's label set is recorded as membership rows, one per label, with the local folder each
    // label projects into — the durable form the views need, written with the message. Nothing reads it yet.
    const membership = await autocommit(client => client.query<{ provider_message_id: string; label_id: string; folder_path: string | null }>(
      `SELECT m.provider_message_id, ml.label_id, ml.folder_path
         FROM message_labels ml JOIN messages m ON m.id = ml.message_id
        WHERE ml.account_id = $1 ORDER BY m.provider_message_id, ml.label_id`,
      [ACCOUNT_ID],
    ));
    expect(membership.rows).toEqual([
      // m1 carries UNREAD (no local folder) and INBOX (the inbox path).
      { provider_message_id: 'm1', label_id: 'INBOX', folder_path: 'INBOX' },
      { provider_message_id: 'm1', label_id: 'UNREAD', folder_path: null },
      // m2 carries the user label Work, which is a folder here, and STARRED, which is not.
      { provider_message_id: 'm2', label_id: 'Label_1', folder_path: 'Work' },
      { provider_message_id: 'm2', label_id: 'STARRED', folder_path: null },
    ]);

    const state = await autocommit(client => client.query<{ cursor: string | null; page_checkpoint: string | null; last_error_code: string | null }>(
      `SELECT cursor, page_checkpoint, last_error_code FROM sync_states
        WHERE user_id = $1 AND account_id = $2 AND feature = 'mail' AND coverage = 'history'`,
      [USER_ID, ACCOUNT_ID],
    ));
    expect(state.rows[0]).toMatchObject({ cursor: '1000', page_checkpoint: null, last_error_code: null });
  });

  it('moves a blocked sender’s freshly stored inbox mail to the trash on Gmail (MAIL-01)', async () => {
    // The block list ran only for IMAP accounts until the engine was given a transport port. This is the
    // end-to-end evidence that a native account now honours it: the message arrives through an ordinary baseline
    // and the block list asks Gmail to move it out of the inbox.
    const connectionId = await seedConnection();
    await syncGmailMailLabels({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeGmail([{ match: /\/labels$/, handle: () => json(LABELS) }]).fetchImpl });
    await autocommit(client => client.query(
      'INSERT INTO block_list (user_id, email_address) VALUES ($1, $2)',
      [USER_ID, 'spammer@example.test'],
    ));

    movedToTrash.value = false;
    const spam = () => message('m9', 't9', movedToTrash.value ? ['UNREAD', 'TRASH'] : ['UNREAD', 'INBOX'], {
      payload: { headers: [
        { name: 'From', value: 'Spammer <spammer@example.test>' },
        { name: 'To', value: 'me@example.test' },
        { name: 'Subject', value: 'Buy something' },
        { name: 'Message-ID', value: '<m9@example.test>' },
      ] },
    });
    const provider = fakeGmail([
      { match: /\/profile$/, handle: () => json({ historyId: '1000' }) },
      // The provider's own view: INBOX before the move, TRASH after it.
      { match: /\/messages$/, handle: url => {
        const label = url.searchParams.get('labelIds');
        if (label === 'INBOX') return json(movedToTrash.value ? { messages: [] } : { messages: [{ id: 'm9', threadId: 't9' }] });
        if (label === 'TRASH') return json(movedToTrash.value ? { messages: [{ id: 'm9', threadId: 't9' }] } : { messages: [] });
        return json({ messages: [] });
      } },
      { match: /\/threads\/t9$/, handle: () => json({ id: 't9', historyId: '1000', messages: [spam()] }) },
    ]);

    const result = await syncGmailMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: provider.fetchImpl,
    });
    expect(result.created).toBe(1);

    // The block list reached the provider, by the id the port resolved from the row, into the account's trash.
    expect(moveGmailMessageToLabelMock, 'the block list did not reach the provider').toHaveBeenCalledWith(expect.objectContaining({
      providerMessageId: 'm9',
      destinationPath: 'Trash',
      sourcePath: 'INBOX',
    }));

    // And the message survives the run, filed in Trash rather than in the inbox and rather than deleted.
    const rows = await storedMessages();
    const stored = rows.find(row => row.provider_message_id === 'm9');
    expect(stored, 'the blocked message was deleted instead of re-filed').toBeDefined();
    expect(stored?.folder).toBe('Trash');
    expect(result.deleted).toBe(0);
  });

  it('reports whether a mailbox’s label membership matches what the provider says (MAIL-02)', async () => {
    // The membership table is written before anything reads it, so this check is what makes that safe: it compares
    // each message's own label set against the rows recorded for it, and an account whose membership was never
    // written (synchronised before migration `0116`) shows up instead of looking empty.
    await seedConnection();

    // A provider message with labels and no membership rows at all — the pre-migration state.
    await autocommit(client => client.query(
      `INSERT INTO messages (account_id, uid, folder, provider_message_id, provider_labels, subject)
       VALUES ($1, 9001, 'INBOX', 'legacy-1', ARRAY['INBOX','UNREAD']::text[], 'Before the migration')`,
      [ACCOUNT_ID],
    ));
    const before = await labelMembershipReport(ACCOUNT_ID);
    expect(before).toMatchObject({ messages: 1, rows: 0, missingRows: 1, unrecorded: 1, extraRows: 0 });

    // Records that carry exactly what the message says: complete.
    const message = await autocommit(client => client.query<{ id: string }>(
      `SELECT id FROM messages WHERE account_id = $1 AND provider_message_id = 'legacy-1'`, [ACCOUNT_ID],
    ));
    await autocommit(client => client.query(
      `INSERT INTO message_labels (message_id, account_id, label_id, folder_path)
       VALUES ($1, $2, 'INBOX', 'INBOX'), ($1, $2, 'UNREAD', NULL)`,
      [message.rows[0]!.id, ACCOUNT_ID],
    ));
    expect(await labelMembershipReport(ACCOUNT_ID)).toMatchObject({ messages: 1, rows: 2, missingRows: 0, extraRows: 0, unrecorded: 0 });

    // A row for a label the message no longer carries is a disagreement in the other direction.
    await autocommit(client => client.query(
      `INSERT INTO message_labels (message_id, account_id, label_id, folder_path) VALUES ($1, $2, 'STARRED', NULL)`,
      [message.rows[0]!.id, ACCOUNT_ID],
    ));
    expect(await labelMembershipReport(ACCOUNT_ID)).toMatchObject({ rows: 3, missingRows: 0, extraRows: 1 });
  });

  it('applies an incremental run from the history cursor: a mailbox move and a deletion', async () => {
    const connectionId = await seedConnection();
    await syncGmailMailLabels({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeGmail([{ match: /\/labels$/, handle: () => json(LABELS) }]).fetchImpl });

    const inboxMessage = message('m1', 't1', ['UNREAD', 'INBOX']);
    const secondMessage = message('m2', 't2', ['INBOX']);
    const provider = fakeGmail([
      { match: /\/profile$/, handle: () => json({ historyId: '1000' }) },
      { match: /\/messages$/, handle: url => json(url.searchParams.get('labelIds') === 'INBOX'
        ? { messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }] }
        : { messages: [] }) },
      { match: /\/threads\/t1$/, handle: () => json({ id: 't1', messages: [inboxMessage] }) },
      { match: /\/threads\/t2$/, handle: () => json({ id: 't2', messages: [secondMessage] }) },
    ]);
    await syncGmailMailMessagesForAccount({ userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: provider.fetchImpl });
    expect(await storedMessages()).toHaveLength(2);

    // The user archives m1 into the Work label and permanently deletes m2.
    const movedMessage = message('m1', 't1', ['UNREAD', 'Label_1']);
    const incremental = fakeGmail([
      { match: /\/history$/, handle: url => {
        expect(url.searchParams.get('startHistoryId')).toBe('1000');
        return json({
          history: [
            { id: '1001', labelsRemoved: [{ message: { id: 'm1', threadId: 't1' }, labelIds: ['INBOX'] }] },
            { id: '1002', messagesDeleted: [{ message: { id: 'm2', threadId: 't2' } }] },
          ],
          historyId: '1002',
        });
      } },
      { match: /\/threads\/t1$/, handle: () => json({ id: 't1', messages: [movedMessage] }) },
      // A deleted message's thread is re-read too; the message is simply no longer in
      // it, which is why the history's own deletion list is applied separately.
      { match: /\/threads\/t2$/, handle: () => json({ id: 't2', messages: [] }) },
    ]);

    const result = await syncGmailMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: incremental.fetchImpl,
    });
    expect(result).toMatchObject({ mode: 'incremental', fullSync: false, updated: 1, deleted: 1, cursor: '1002' });

    const rows = await storedMessages();
    expect(rows.map(row => [row.provider_message_id, row.folder])).toEqual([['m1', 'Work']]);
    expect(rows[0]?.provider_labels).toEqual(['UNREAD', 'Label_1']);
  });

  it('rebuilds instead of advancing the cursor when the history feed had more pages than one run reads', async () => {
    // SYNC-06: the history loop is capped. Leaving the cap with a page token still set means the feed was not
    // read to its end, and returning the last page's history id would skip every change on the remaining pages
    // for ever. Many pages can describe the same few threads, so the unique-thread guard cannot detect this.
    const connectionId = await seedConnection();
    await syncGmailMailLabels({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeGmail([{ match: /\/labels$/, handle: () => json(LABELS) }]).fetchImpl });

    await syncGmailMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG,
      fetchImpl: fakeGmail([
        { match: /\/profile$/, handle: () => json({ historyId: '1000' }) },
        { match: /\/messages$/, handle: url => json(url.searchParams.get('labelIds') === 'INBOX'
          ? { messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }] }
          : { messages: [] }) },
        { match: /\/threads\/t1$/, handle: () => json({ id: 't1', messages: [message('m1', 't1', ['INBOX'])] }) },
        { match: /\/threads\/t2$/, handle: () => json({ id: 't2', messages: [message('m2', 't2', ['INBOX'])] }) },
      ]).fetchImpl,
    });
    expect(await storedMessages()).toHaveLength(2);

    // Every history page claims another page follows and repeats one thread, so the run hits the page cap with
    // few distinct threads and the old code advanced the cursor anyway. The rebuild then reconciles m2 away.
    const incremental = fakeGmail([
      { match: /\/history$/, handle: () => json({
        history: [{ id: '1001', labelsAdded: [{ message: { id: 'm1', threadId: 't1' }, labelIds: ['UNREAD'] }] }],
        historyId: '1010',
        nextPageToken: 'more',
      }) },
      { match: /\/profile$/, handle: () => json({ historyId: '2000' }) },
      { match: /\/messages$/, handle: url => json(url.searchParams.get('labelIds') === 'INBOX'
        ? { messages: [{ id: 'm1', threadId: 't1' }] }
        : { messages: [] }) },
      { match: /\/threads\/t1$/, handle: () => json({ id: 't1', messages: [message('m1', 't1', ['INBOX'])] }) },
    ]);
    const result = await syncGmailMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: incremental.fetchImpl,
    });

    expect(result.mode).toBe('baseline');
    // The cursor is the fresh baseline's history id, never the unread feed's last page.
    expect(result.cursor).toBe('2000');
    expect(result.cursor).not.toBe('1010');
    expect((await storedMessages()).map(row => row.provider_message_id)).toEqual(['m1']);
  });

  it('rebuilds and reconciles when Gmail no longer holds the stored history id', async () => {
    const connectionId = await seedConnection();
    await syncGmailMailLabels({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeGmail([{ match: /\/labels$/, handle: () => json(LABELS) }]).fetchImpl });

    const provider = fakeGmail([
      { match: /\/profile$/, handle: () => json({ historyId: '1000' }) },
      { match: /\/messages$/, handle: url => json(url.searchParams.get('labelIds') === 'INBOX'
        ? { messages: [{ id: 'm1', threadId: 't1' }] } : { messages: [] }) },
      { match: /\/threads\/t1$/, handle: () => json({ id: 't1', messages: [message('m1', 't1', ['INBOX'])] }) },
    ]);
    await syncGmailMailMessagesForAccount({ userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: provider.fetchImpl });

    // A row the baseline no longer lists: whatever deleted it happened while the
    // cursor was unusable, and a plain re-read would have left it behind.
    await autocommit(client => client.query(
      `INSERT INTO messages (account_id, uid, folder, subject, provider_message_id, provider_labels)
       VALUES ($1, 999, 'INBOX', 'Vanished', 'gone', ARRAY['INBOX'])`, [ACCOUNT_ID],
    ));

    const expired = fakeGmail([
      { match: /\/history$/, handle: () => json({ error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }, 404) },
      { match: /\/profile$/, handle: () => json({ historyId: '2000' }) },
      { match: /\/messages$/, handle: url => json(url.searchParams.get('labelIds') === 'INBOX'
        ? { messages: [{ id: 'm1', threadId: 't1' }] } : { messages: [] }) },
      { match: /\/threads\/t1$/, handle: () => json({ id: 't1', messages: [message('m1', 't1', ['INBOX', 'STARRED'])] }) },
    ]);

    const result = await syncGmailMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: expired.fetchImpl,
    });
    expect(result).toMatchObject({ mode: 'baseline', fullSync: true, deleted: 1, cursor: '2000' });
    const rows = await storedMessages();
    expect(rows.map(row => row.provider_message_id)).toEqual(['m1']);
    expect(rows[0]?.is_starred).toBe(true);
  });

  it('refuses a second concurrent run through the sync lease', async () => {
    const connectionId = await seedConnection();
    await inTransaction(async client => {
      const syncStateId = await ensureSyncState(client, {
        userId: USER_ID, connectionId, accountId: ACCOUNT_ID, feature: 'mail', coverage: 'history',
      });
      await acquireSyncLease(client, { syncStateId, owner: 'other-worker', leaseSeconds: 300 });
    });

    await expect(syncGmailMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG,
      fetchImpl: fakeGmail([{ match: /.*/, handle: () => json({}) }]).fetchImpl,
    })).rejects.toMatchObject({ code: 'SYNC_ALREADY_RUNNING' });
  });

  it('pauses a baseline at its budget and re-reads the interrupted page instead of skipping it', async () => {
    const connectionId = await seedConnection();
    await syncGmailMailLabelsForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG,
      fetchImpl: fakeGmail([{ match: /\/labels$/, handle: () => json(LABELS) }]).fetchImpl,
    });

    // Two threads are the run's whole budget, and the first page names three of them.
    const firstUrls: string[] = [];
    const first = fakeGmail([
      { match: /\/profile$/, handle: () => json({ historyId: '3000' }) },
      { match: /\/messages$/, handle: url => {
        firstUrls.push(url.toString());
        // Only the inbox is non-empty, so the run reaches INBOX after the empty labels
        // and pauses in the middle of its listing.
        return url.searchParams.get('labelIds') === 'INBOX'
          ? json({ messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }, { id: 'm3', threadId: 't3' }], nextPageToken: 'page-2' })
          : json({ messages: [] });
      } },
      { match: /\/threads\/t1$/, handle: () => json({ id: 't1', messages: [message('m1', 't1', ['INBOX'])] }) },
      { match: /\/threads\/t2$/, handle: () => json({ id: 't2', messages: [message('m2', 't2', ['INBOX'])] }) },
    ]);

    const paused = await syncGmailMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG,
      fetchImpl: first.fetchImpl, maxThreadsPerRun: 2,
    });
    expect(paused).toMatchObject({ mode: 'baseline', incomplete: true, created: 2, cursor: null });
    // The cursor is not advanced on a paused baseline, and the position — including
    // the history id captured before the listing — is stored.
    const pausedState = await autocommit(client => client.query<{ cursor: string | null; page_checkpoint: string | null }>(
      `SELECT cursor, page_checkpoint FROM sync_states
        WHERE user_id = $1 AND account_id = $2 AND feature = 'mail' AND coverage = 'history'`,
      [USER_ID, ACCOUNT_ID],
    ));
    expect(pausedState.rows[0]?.cursor).toBeNull();
    // The checkpoint names the label but no page: `nextPageToken` would point at the *following* page and skip
    // m2 for ever, because Gmail's token only ever moves forward (SYNC-05).
    expect(JSON.parse(pausedState.rows[0]?.page_checkpoint ?? '{}')).toMatchObject({
      targetId: 'label:INBOX', pageToken: null, startHistoryId: '3000', processedThreadIds: ['t1', 't2'],
    });
    expect(JSON.parse(pausedState.rows[0]?.page_checkpoint ?? '{}').baselineRunId).toEqual(expect.any(String));
    expect(await storedMessages()).toHaveLength(2);

    // The resume re-lists INBOX from its first page, skips the durable t1/t2 checkpoint,
    // and consumes t3 with the same budget. The label therefore completes without an
    // ever-growing budget or a reset to its first two threads.
    const resumeUrls: string[] = [];
    const second = fakeGmail([
      { match: /\/messages$/, handle: url => {
        resumeUrls.push(url.toString());
        return url.searchParams.get('labelIds') === 'INBOX'
          ? json({ messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }, { id: 'm3', threadId: 't3' }] })
          : json({ messages: [] });
      } },
      { match: /\/threads\/t3$/, handle: () => json({ id: 't3', messages: [message('m3', 't3', ['INBOX'])] }) },
    ]);
    const resumed = await syncGmailMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG,
      fetchImpl: second.fetchImpl, maxThreadsPerRun: 2,
    });
    expect(resumed).toMatchObject({ incomplete: false, created: 1, cursor: '3000' });
    // The interrupted page was re-read, never the page after it, and no profile call was needed: the history id
    // was already captured by the paused run.
    expect(resumeUrls[0]).not.toContain('pageToken=');
    expect(resumeUrls.some(url => url.includes('/profile'))).toBe(false);
    expect((await storedMessages()).map(row => row.provider_message_id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('treats a budget that ends exactly on the last thread as a finished label', async () => {
    // The old test was `budget <= 0` after the thread loop, so a run whose budget happened to end on the final
    // thread of the final page looked interrupted: it stored a null page token and restarted the label on every
    // subsequent run, never finishing (SYNC-05).
    const connectionId = await seedConnection();
    await syncGmailMailLabelsForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG,
      fetchImpl: fakeGmail([{ match: /\/labels$/, handle: () => json(LABELS) }]).fetchImpl,
    });

    const result = await syncGmailMailMessagesForAccount({
      userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, maxThreadsPerRun: 1,
      fetchImpl: fakeGmail([
        { match: /\/profile$/, handle: () => json({ historyId: '4000' }) },
        { match: /\/messages$/, handle: url => url.searchParams.get('labelIds') === 'INBOX'
          ? json({ messages: [{ id: 'm1', threadId: 't1' }] })
          : json({ messages: [] }) },
        { match: /\/threads\/t1$/, handle: () => json({ id: 't1', messages: [message('m1', 't1', ['INBOX'])] }) },
      ]).fetchImpl,
    });

    expect(result).toMatchObject({ mode: 'baseline', incomplete: false, cursor: '4000' });
    expect((await storedMessages()).map(row => row.provider_message_id)).toEqual(['m1']);
  });

  it('carries a durable seen generation across resumed label and all-mail scans', async () => {
    const connectionId = await seedConnection();
    await syncGmailMailLabels({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeGmail([{ match: /\/labels$/, handle: () => json(LABELS) }]).fetchImpl });
    // X predates the expired cursor but no longer exists remotely. Its removal must
    // wait for a complete all-mail generation, not the first resumed page.
    await autocommit(client => client.query(
      `INSERT INTO messages (account_id, uid, folder, subject, provider_message_id, provider_labels, synced_at)
       VALUES ($1, 900, 'INBOX', 'Stale', 'gone', ARRAY['INBOX'], NOW() - INTERVAL '1 hour')`, [ACCOUNT_ID],
    ));
    const provider = fakeGmail([
      { match: /\/profile$/, handle: () => json({ historyId: '5000' }) },
      { match: /\/messages$/, handle: url => {
        const label = url.searchParams.get('labelIds');
        if (label === 'INBOX') return json({ messages: [{ id: 'y', threadId: 'ty' }, { id: 'z', threadId: 'tz' }] });
        if (label === null) return json({ messages: [{ id: 'y', threadId: 'ty' }, { id: 'z', threadId: 'tz' }, { id: 'a', threadId: 'ta' }] });
        return json({ messages: [] });
      } },
      { match: /\/threads\/ty$/, handle: () => json({ id: 'ty', messages: [message('y', 'ty', ['INBOX'])] }) },
      { match: /\/threads\/tz$/, handle: () => json({ id: 'tz', messages: [message('z', 'tz', ['INBOX'])] }) },
      // A is first seen through account-wide scan and has no folder-bearing label.
      { match: /\/threads\/ta$/, handle: () => json({ id: 'ta', messages: [message('a', 'ta', ['UNREAD', 'STARRED'])] }) },
    ]);

    let result = await syncGmailMailMessagesForAccount({ userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: provider.fetchImpl, maxThreadsPerRun: 1 });
    expect(result).toMatchObject({ incomplete: true, cursor: null });
    expect((await storedMessages()).map(row => row.provider_message_id)).toContain('gone');
    // Continue the same generation until the account-wide scan has completed.
    for (let attempt = 0; attempt < 8 && result.incomplete; attempt++) {
      result = await syncGmailMailMessagesForAccount({ userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG, fetchImpl: provider.fetchImpl, maxThreadsPerRun: 1 });
    }
    expect(result).toMatchObject({ incomplete: false, cursor: '5000' });
    const rows = await autocommit(client => client.query<{ provider_message_id: string; is_archived: boolean }>(
      'SELECT provider_message_id, is_archived FROM messages WHERE account_id = $1 ORDER BY provider_message_id', [ACCOUNT_ID],
    ));
    expect(rows.rows).toEqual([
      { provider_message_id: 'a', is_archived: true },
      { provider_message_id: 'y', is_archived: false },
      { provider_message_id: 'z', is_archived: false },
    ]);
    const archive = await listMessages({ userId: USER_ID, accountId: ACCOUNT_ID, folder: 'Archive' });
    const inbox = await listMessages({ userId: USER_ID, accountId: ACCOUNT_ID, folder: 'INBOX' });
    // The public listing deliberately does not expose provider identities; prove the
    // archive/inbox visibility split through stable projected fields instead.
    expect(archive.messages.map(row => row.subject)).toEqual(['Subject a']);
    expect(inbox.messages.map(row => row.subject).sort()).toEqual(['Subject y', 'Subject z']);
  });

  it('records the failure and keeps the error code when Gmail refuses the call', async () => {
    const connectionId = await seedConnection();
    const forbidden = fakeGmail([{ match: /\/labels$/, handle: () => json({ error: { code: 403, message: 'insufficient scope', status: 'PERMISSION_DENIED', errors: [{ reason: 'insufficientPermissions' }] } }, 403) }]);

    await expect(syncGmailMailLabels({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: forbidden.fetchImpl }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPES' });

    expect(await storedFolders()).toEqual([]);
    const state = await autocommit(client => client.query<{ last_error_code: string | null }>(
      `SELECT last_error_code FROM sync_states WHERE user_id = $1 AND feature = 'mail' AND coverage = 'labels'`, [USER_ID],
    ));
    expect(state.rows[0]?.last_error_code).toBe('INSUFFICIENT_SCOPES');
  });
});
