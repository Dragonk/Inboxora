import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { query } from './db.js';

/**
 * The scheduler's target query, on real PostgreSQL.
 *
 * The dispatch fix (Gmail's `mail_label` kind) only helps if the query that builds the target list admits the
 * collection Gmail's label discovery writes. That row is linked through `local_folder_id` (migration 0107),
 * and the query requires one of the three local links to be present — so this pins the whole contract: a
 * native Gmail connection with a `mail_label` collection linked to a folder reaches
 * `listProviderSyncTargets()`, a Graph `mail_folder` one does too, and a collection with no local link is
 * still absent.
 *
 *   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=<db> DB_USER=mailflow_test DB_PASSWORD=mailflow_test \
 *     npx vitest run src/services/providerSyncTargets.integration.test.ts
 */

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const calls = vi.hoisted(() => ({
  gmailLabels: vi.fn(async () => ({ labels: 0 })),
  gmailMessages: vi.fn(async () => ({ messages: 0 })),
  graphFolders: vi.fn(async () => []),
  graphMessages: vi.fn(async () => ({ messages: 0 })),
}));
vi.mock('./providers/google/gmailMailSync.js', () => ({
  syncGmailMailLabelsForAccount: calls.gmailLabels,
  syncGmailMailMessagesForAccount: calls.gmailMessages,
  listGmailMailAccounts: async () => ['account-1'],
}));
vi.mock('./providers/microsoft/graphMailSync.js', () => ({
  syncGraphMailFolders: calls.graphFolders,
  syncGraphMailMessagesForAccount: calls.graphMessages,
}));

import { listProviderSyncTargets, runProviderSyncs } from './providerSyncScheduler.js';

const userId = randomUUID();
const googleConnection = randomUUID();
const microsoftConnection = randomUUID();
const googleAccount = randomUUID();
const microsoftAccount = randomUUID();

async function createFolder(accountId: string, name: string): Promise<string> {
  const folder = await query<{ id: string }>(
    `INSERT INTO folders (account_id, name, path, special_use) VALUES ($1, $2, $2, NULL) RETURNING id`,
    [accountId, name],
  );
  return folder.rows[0]!.id;
}

beforeAll(async () => {
  if (!hasPg) return;
  process.env.ENCRYPTION_KEY ||= 'e'.repeat(64);
  // The scheduler only runs a provider whose configuration is present; the credentials are never used because
  // the sync functions are mocked at the module boundary.
  process.env.GOOGLE_CLIENT_ID ||= 'sched-client';
  process.env.GOOGLE_CLIENT_SECRET ||= 'sched-secret';
  process.env.MS_CLIENT_ID ||= 'sched-ms-client';
  await query("INSERT INTO users (id, username) VALUES ($1, 'sched-targets') ON CONFLICT (id) DO NOTHING", [userId]);
  // The connections first: the account's link is a foreign key to them.
  await query(
    `INSERT INTO provider_connections (id, user_id, provider, issuer, subject, provider_user_id, status)
     VALUES ($1, $3, 'google', 'https://accounts.google.com', 'google-subject', 'sched@gmail.test', 'active'),
            ($2, $3, 'microsoft', 'https://login.microsoftonline.com/common/v2.0', 'graph-subject', 'sched@outlook.test', 'active')`,
    [googleConnection, microsoftConnection, userId],
  );
  await query(
    `INSERT INTO email_accounts (id, user_id, name, email_address, protocol, imap_host, mail_transport, provider_connection_id)
     VALUES ($1, $3, 'Gmail', 'sched@gmail.test', 'imap', 'imap.gmail.com', 'gmail_api', $4),
            ($2, $3, 'Outlook', 'sched@outlook.test', 'imap', 'outlook.office365.com', 'microsoft_graph', $5)`,
    [googleAccount, microsoftAccount, userId, googleConnection, microsoftConnection],
  );

  // Exactly what Gmail's label discovery writes: kind `mail_label`, linked through local_folder_id.
  const googleFolder = await createFolder(googleAccount, 'INBOX');
  await query(
    `INSERT INTO integration_collections (user_id, connection_id, account_id, kind, remote_id, local_folder_id, enabled, source_access, user_access, dav_mode)
     VALUES ($1, $2, $3, 'mail_label', 'INBOX', $4, true, 'read_only', 'source', 'off')`,
    [userId, googleConnection, googleAccount, googleFolder],
  );

  // Graph's discovery, and a collection with no local link that must stay out of the target list.
  const graphFolder = await createFolder(microsoftAccount, 'Inbox');
  await query(
    `INSERT INTO integration_collections (user_id, connection_id, account_id, kind, remote_id, local_folder_id, enabled, source_access, user_access, dav_mode)
     VALUES ($1, $2, $3, 'mail_folder', 'inbox-id', $4, true, 'read_only', 'source', 'off'),
            ($1, $2, $3, 'mail_folder', 'orphan-id', NULL, true, 'read_only', 'source', 'off')`,
    [userId, microsoftConnection, microsoftAccount, graphFolder],
  );
});

afterAll(async () => {
  if (!hasPg) return;
  await query('DELETE FROM email_accounts WHERE user_id = $1', [userId]);
  await query('DELETE FROM provider_connections WHERE user_id = $1', [userId]);
  await query('DELETE FROM users WHERE id = $1', [userId]);
});

describeOrSkip('provider sync targets (PostgreSQL)', () => {
  it('includes a native Gmail connection whose collection is a mail_label with a local folder', async () => {
    const targets = await listProviderSyncTargets();
    const google = targets.find(target => target.connectionId === googleConnection);
    const microsoft = targets.find(target => target.connectionId === microsoftConnection);

    expect(google, 'the Gmail connection is not a scheduler target').toBeDefined();
    expect(google!.features).toContain('mail_label');
    expect(microsoft).toBeDefined();
    expect(microsoft!.features).toContain('mail_folder');
    // Only the linked Graph collection is aggregated; the orphan contributes nothing.
    expect(microsoft!.features).toEqual(['mail_folder']);
  });

  it('runs the Gmail message sync for its mail_label target', async () => {
    calls.gmailLabels.mockClear();
    calls.gmailMessages.mockClear();

    const summary = await runProviderSyncs();

    expect(summary.failed, JSON.stringify(summary)).toBe(0);
    expect(calls.gmailLabels).toHaveBeenCalled();
    expect(calls.gmailMessages).toHaveBeenCalledWith(expect.objectContaining({ connectionId: googleConnection }));
  });
});
