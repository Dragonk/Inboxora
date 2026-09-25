// Real PostgreSQL tests for the Gmail draft mirror (P08). The local row is keyed on
// the **message** id the draft wraps, so a later history sync updates it rather than
// inserting a second row for the same draft.
//
// Run with:
//   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=inboxora_gmail_gate DB_USER=mailflow_test DB_PASSWORD=mailflow_test \
//     npx vitest run src/services/providers/google/gmailMailDrafts.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db.js';
import { gmailDraftMessageIdForLocalRow, upsertGmailDraftRecord } from './gmailMailDrafts.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-0000000007e1';
const ACCOUNT_ID = '00000000-0000-0000-0000-0000000007e2';
const originalKey = process.env.ENCRYPTION_KEY;

async function autocommit<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

async function storedDrafts(): Promise<Array<{
  uid: string;
  folder: string;
  provider_message_id: string | null;
  provider_labels: string[] | null;
  thread_id: string | null;
  provider_thread_id: string | null;
  draft_bcc_addresses: Array<{ address: string }> | null;
  subject: string | null;
}>> {
  const result = await autocommit(client => client.query(
    `SELECT uid::text AS uid, folder, provider_message_id, provider_labels, thread_id, provider_thread_id,
            draft_bcc_addresses, subject
       FROM messages WHERE account_id = $1 ORDER BY provider_message_id`,
    [ACCOUNT_ID],
  ));
  return result.rows;
}

const RECORD = {
  accountId: ACCOUNT_ID,
  folder: 'Drafts',
  providerMessageId: 'msg-1',
  threadId: 'thread-1',
  providerNamespace: `gmail:${ACCOUNT_ID}:gmail.googleapis.com`,
  messageId: '<draft-1@example.test>',
  subject: 'Draft',
  fromName: 'Sam',
  fromEmail: 'sam@gmail.test',
  to: [{ email: 'you@example.test' }],
  cc: [],
  bcc: [{ email: 'secret@example.test' }],
  snippet: 'half written',
  bodyHtml: '<p>half written</p>',
  bodyText: 'half written',
  draftComposition: { version: 2, authoredBody: 'half written' },
};

describeOrSkip('Gmail draft mirror (PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'gmail-drafts-user') ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    ));
  });

  afterAll(async () => {
    await autocommit(client => client.query('DELETE FROM users WHERE id = $1', [USER_ID]));
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
  });

  beforeEach(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM email_accounts WHERE user_id = $1', [USER_ID]);
      await client.query(
        `INSERT INTO email_accounts (id, user_id, name, email_address, protocol, imap_host, mail_transport)
         VALUES ($1, $2, 'Gmail', 'sam@gmail.test', 'imap', 'imap.gmail.com', 'gmail_api')
         ON CONFLICT (id) DO UPDATE SET mail_transport = 'gmail_api'`,
        [ACCOUNT_ID, USER_ID],
      );
    });
  });

  it('mirrors the draft keyed on the message id, with the Gmail thread identity and the DRAFT label', async () => {
    const record = await upsertGmailDraftRecord(RECORD);
    expect(record.uid).toBeTruthy();

    const rows = await storedDrafts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      folder: 'Drafts',
      provider_message_id: 'msg-1',
      provider_labels: ['DRAFT'],
      thread_id: 'gmail:thread-1',
      provider_thread_id: 'thread-1',
      subject: 'Draft',
    });
    expect(rows[0]?.draft_bcc_addresses).toEqual([{ email: 'secret@example.test' }]);
    // The compatibility uid is the one the rest of the application addresses the row by.
    expect(rows[0]?.uid).toBe(record.uid);
    // And the route can resolve the provider message identity back from it.
    expect(await gmailDraftMessageIdForLocalRow(ACCOUNT_ID, record.uid, 'Drafts')).toBe('msg-1');
  });

  it('re-saving the same draft updates the row instead of inserting a second one', async () => {
    const first = await upsertGmailDraftRecord(RECORD);
    const second = await upsertGmailDraftRecord({ ...RECORD, subject: 'Draft edited', snippet: 'edited' });

    const rows = await storedDrafts();
    expect(rows).toHaveLength(1);
    expect(second.rowId).toBe(first.rowId);
    expect(rows[0]).toMatchObject({ subject: 'Draft edited', provider_message_id: 'msg-1' });
  });
});
