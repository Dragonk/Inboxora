// Real PostgreSQL tests for the Gmail API message mutations (P08). The provider is
// faked at the HTTP boundary; the operation journal, the local re-homing and the
// label bookkeeping are real, and the assertions read the persisted row exactly as
// the mail list would.
//
// Run with:
//   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=inboxora_gmail_gate DB_USER=mailflow_test DB_PASSWORD=mailflow_test \
//     npx vitest run src/services/providers/google/gmailMailMutations.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db.js';
import {
  GOOGLE_GRANT_AUDIENCE,
  GOOGLE_ISSUER,
  storeOAuthGrant,
  upsertProviderConnection,
} from '../../providerAuthService.js';
import { syncGmailMailLabelsForAccount } from './gmailMailSync.js';
import { archiveGmailMessage, moveGmailMessageToLabel } from './gmailMailMove.js';
import { deleteGmailMessagePermanently } from './gmailMailMutations.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-0000000006d1';
const ACCOUNT_ID = '00000000-0000-0000-0000-0000000006d2';
const CONFIG = { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://inboxora.example/oauth/google/callback' };
const originalKey = process.env.ENCRYPTION_KEY;

interface Route {
  match: RegExp;
  handle: (url: URL) => Response | Promise<Response>;
}

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body } as Response;
}

function noContent(status = 204): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => null } as Response;
}

/**
 * A fake Gmail API routed by path, injected at the HTTP boundary.
 *
 * The mutations under test call the module's own provider functions, which use the
 * global `fetch`; stubbing it is what keeps the assertion about *what Gmail was
 * asked* — the label sets and the journal — rather than about a mock's call log.
 */
async function withFetch<T>(
  routes: Route[],
  fn: (calls: Array<{ url: string; method: string; body: unknown }>) => Promise<T>,
): Promise<T> {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
    const raw = String(input);
    const url = new URL(raw);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url: raw, method: init?.method ?? 'GET', body });
    const route = routes.find(candidate => candidate.match.test(url.pathname));
    if (!route) throw new Error(`Unexpected Gmail call: ${raw}`);
    return route.handle(url);
  }) as unknown as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

const LABELS = {
  labels: [
    { id: 'INBOX', name: 'Inbox', type: 'system' },
    { id: 'TRASH', name: 'Trash', type: 'system' },
    { id: 'SPAM', name: 'Spam', type: 'system' },
    { id: 'Label_1', name: 'Work', type: 'user' },
  ],
};

async function seedAccountWithLabels(): Promise<string> {
  const connectionId = await inTransaction(async client => {
    const id = await upsertProviderConnection(client, {
      userId: USER_ID, provider: 'google', issuer: GOOGLE_ISSUER, subject: 'google-sub-mutations',
    });
    await storeOAuthGrant(client, {
      connectionId: id,
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
      [ACCOUNT_ID, USER_ID, id],
    );
    return id;
  });
  await withFetch(
    [{ match: /\/labels$/, handle: () => json(LABELS) }],
    () => syncGmailMailLabelsForAccount({ userId: USER_ID, connectionId, accountId: ACCOUNT_ID, config: CONFIG }),
  );
  return connectionId;
}

async function insertMessage(input: {
  uid: number;
  folder: string;
  providerMessageId: string;
  providerLabels: string[];
}): Promise<string> {
  const result = await autocommit(client => client.query<{ id: string }>(
    `INSERT INTO messages (account_id, uid, folder, subject, provider_message_id, provider_namespace, provider_labels, is_read, is_starred)
     VALUES ($1, $2, $3, 'Subject', $4, $5, $6::text[], false, false)
     RETURNING id`,
    [
      ACCOUNT_ID, input.uid, input.folder, input.providerMessageId,
      `gmail:${ACCOUNT_ID}:gmail.googleapis.com`, input.providerLabels,
    ],
  ));
  const id = result.rows[0]?.id;
  if (!id) throw new Error('could not seed the message row');
  return id;
}

async function storedRow(id: string): Promise<{ folder: string; provider_labels: string[] | null; is_archived: boolean } | null> {
  const result = await autocommit(client => client.query<{ folder: string; provider_labels: string[] | null; is_archived: boolean }>(
    'SELECT folder, provider_labels, is_archived FROM messages WHERE id = $1', [id],
  ));
  return result.rows[0] ?? null;
}

async function journalRows(): Promise<Array<{ status: string; operation: string; resource_type: string }>> {
  const result = await autocommit(client => client.query<{ status: string; operation: string; resource_type: string }>(
    `SELECT status, operation, resource_type FROM provider_operations WHERE user_id = $1 AND account_id = $2 ORDER BY created_at`,
    [USER_ID, ACCOUNT_ID],
  ));
  return result.rows;
}

describeOrSkip('Gmail API message mutations (PostgreSQL)', () => {
  let connectionId = '';

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'gmail-mutations-user') ON CONFLICT (id) DO NOTHING`,
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
      await client.query('DELETE FROM provider_connections WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM email_accounts WHERE user_id = $1', [USER_ID]);
    });
    connectionId = await seedAccountWithLabels();
  });

  it('moves a message by adding the destination label and removing the mailbox it leaves', async () => {
    const rowId = await insertMessage({ uid: 1, folder: 'INBOX', providerMessageId: 'm1', providerLabels: ['UNREAD', 'INBOX'] });

    const result = await withFetch(
      [{ match: /\/modify$/, handle: () => noContent() }],
      async calls => {
        const moved = await moveGmailMessageToLabel({
          userId: USER_ID, accountId: ACCOUNT_ID, connectionId, config: CONFIG,
          resourceId: rowId, providerMessageId: 'm1', destinationPath: 'Work', sourcePath: 'INBOX',
        });
        return { moved, calls };
      },
    );

    expect(result.moved).toMatchObject({ moved: true, folder: 'Work' });
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.url).toContain('/users/me/messages/m1/modify');
    expect(result.calls[0]?.body).toEqual({ addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] });
    // The local row moved with its labels: the stored set is what a later label
    // deletion is resolved against, so it must follow the provider.
    expect(await storedRow(rowId)).toEqual({ folder: 'Work', provider_labels: ['Label_1', 'UNREAD'], is_archived: false });
    expect(await journalRows()).toEqual([{ status: 'committed', operation: 'update', resource_type: 'message' }]);
  });

  it('archives by removing INBOX and keeps the row under a label it still carries', async () => {
    const rowId = await insertMessage({ uid: 2, folder: 'INBOX', providerMessageId: 'm2', providerLabels: ['INBOX', 'Label_1'] });
    const result = await withFetch(
      [{ match: /\/modify$/, handle: () => noContent() }],
      calls => archiveGmailMessage({
        userId: USER_ID, accountId: ACCOUNT_ID, connectionId, config: CONFIG,
        resourceId: rowId, providerMessageId: 'm2',
      }).then(archived => ({ archived, calls })),
    );
    expect(result.archived).toMatchObject({ archived: true, folder: 'Work' });
    expect(result.calls[0]?.body).toEqual({ addLabelIds: [], removeLabelIds: ['INBOX'] });
    expect(await storedRow(rowId)).toEqual({ folder: 'Work', provider_labels: ['Label_1'], is_archived: false });
  });

  it('archives an unlabelled message out of the local view rather than inventing a folder', async () => {
    const rowId = await insertMessage({ uid: 3, folder: 'INBOX', providerMessageId: 'm3', providerLabels: ['INBOX', 'UNREAD'] });
    const result = await withFetch(
      [{ match: /\/modify$/, handle: () => noContent() }],
      () => archiveGmailMessage({
        userId: USER_ID, accountId: ACCOUNT_ID, connectionId, config: CONFIG,
        resourceId: rowId, providerMessageId: 'm3',
      }),
    );
    // Gmail has no Archive label: keep the local identity and mark its virtual
    // Archive state; the listing predicate, not a made-up remote folder, hides it
    // from INBOX.
    expect(result).toMatchObject({ archived: true, folder: null });
    expect(await storedRow(rowId)).toEqual({ folder: 'INBOX', provider_labels: ['UNREAD'], is_archived: true });
  });

  it('parks a retryable refusal as a scheduled journal row instead of losing the change', async () => {
    const rowId = await insertMessage({ uid: 4, folder: 'INBOX', providerMessageId: 'm4', providerLabels: ['INBOX'] });
    const limited = new Headers({ 'retry-after': '30' });

    const result = await withFetch(
      [{
        match: /\/modify$/,
        handle: () => ({ ok: false, status: 429, headers: limited, json: async () => ({ error: { code: 429, message: 'rate limited' } }) }) as Response,
      }],
      () => moveGmailMessageToLabel({
        userId: USER_ID, accountId: ACCOUNT_ID, connectionId, config: CONFIG,
        resourceId: rowId, providerMessageId: 'm4', destinationPath: 'Work', sourcePath: 'INBOX',
      }),
    );

    expect(result).toMatchObject({ moved: false, code: 'RATE_LIMITED' });
    // The local row is untouched: a change that was not applied must not look applied.
    expect(await storedRow(rowId)).toEqual({ folder: 'INBOX', provider_labels: ['INBOX'], is_archived: false });
    const journal = await journalRows();
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ status: 'pending', operation: 'update', resource_type: 'message' });
  });

  it('reports a permanent removal and leaves the local row to the caller', async () => {
    const rowId = await insertMessage({ uid: 5, folder: 'INBOX', providerMessageId: 'm5', providerLabels: ['INBOX'] });
    const removed = await withFetch(
      [{ match: /\/messages\/m5$/, handle: () => noContent() }],
      () => deleteGmailMessagePermanently({
        userId: USER_ID, accountId: ACCOUNT_ID, connectionId, config: CONFIG,
        resourceId: rowId, providerMessageId: 'm5',
      }),
    );
    expect(removed).toEqual({ deleted: true });
    expect(await journalRows()).toEqual([{ status: 'committed', operation: 'delete', resource_type: 'message' }]);
    // The route removes the local row once the provider confirms; the helper does not
    // guess, so the row is still here.
    expect(await storedRow(rowId)).not.toBeNull();
  });
});
