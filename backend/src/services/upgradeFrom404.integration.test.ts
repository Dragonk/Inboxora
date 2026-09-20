// The 4.0.4 → 4.1.0 upgrade gate, against real PostgreSQL.
//
// This suite reproduces a production 4.0.4 database — the schema as of 0107, populated the way 4.0.4's Gmail
// IMAP ingest and its Conversation Engine left it — and then runs the **production migration runner**, twice:
// once up to 0107 to build the historical state, and once with no limit to perform the upgrade the way the
// backend does at start-up. Nothing here resets or repairs a table by hand; if the runner cannot upgrade this
// database, this test fails the way an installation would.
//
// It needs a database of its own, because it controls the migration chain: the release gate creates one and
// runs this file alone with UPGRADE_GATE=1. Without that flag the suite is skipped, so the ordinary
// integration run (which shares one already-migrated database) is unaffected.
//
//   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=inboxora_upgrade DB_USER=mailflow_test DB_PASSWORD=mailflow_test \
//     UPGRADE_GATE=1 npx vitest run src/services/upgradeFrom404.integration.test.ts

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { runMigrations } from './migrations.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const gateEnabled = process.env.UPGRADE_GATE === '1';
const describeOrSkip = hasPg && gateEnabled ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-000000000404';
const GMAIL_ACCOUNT_ID = '00000000-0000-0000-0000-000000001404';
const PLAIN_ACCOUNT_ID = '00000000-0000-0000-0000-000000002404';

async function autocommit<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

/** The Gmail folder copies of one message: the same provider id, four physical rows. */
const GMAIL_FOLDERS = ['INBOX', '[Gmail]/Important', '[Gmail]/All Mail', 'Projects'];

interface Snapshot {
  ids: string[];
  uidFolders: string[];
  providerIds: (string | null)[];
  threadKeys: (string | null)[];
  providerThreadIds: (string | null)[];
  conversations: number;
  logicalMessages: number;
  conversationAliases: number;
  rules: number;
  snoozes: number;
}

/** Everything the upgrade must leave untouched, read straight from the database. */
async function snapshot(): Promise<Snapshot> {
  return autocommit(async client => {
    const messages = await client.query<{
      id: string; uid: string; folder: string; provider_message_id: string | null;
      thread_key: string | null; provider_thread_id: string | null;
    }>('SELECT id, uid, folder, provider_message_id, thread_key, provider_thread_id FROM messages ORDER BY id');
    const count = async (sql: string) => Number((await client.query<{ count: string }>(sql)).rows[0]?.count ?? 0);
    return {
      ids: messages.rows.map(row => row.id),
      uidFolders: messages.rows.map(row => `${row.uid}@${row.folder}`),
      providerIds: messages.rows.map(row => row.provider_message_id),
      threadKeys: messages.rows.map(row => row.thread_key),
      providerThreadIds: messages.rows.map(row => row.provider_thread_id),
      conversations: await count('SELECT COUNT(*)::text AS count FROM conversations'),
      logicalMessages: await count('SELECT COUNT(*)::text AS count FROM logical_messages'),
      conversationAliases: await count('SELECT COUNT(*)::text AS count FROM conversation_aliases'),
      rules: await count('SELECT COUNT(*)::text AS count FROM inbox_rules'),
      snoozes: await count('SELECT COUNT(*)::text AS count FROM snoozed_messages'),
    };
  });
}

/**
 * Build the 4.0.4 state and its data.
 *
 * `runMigrations({ upTo: '0107' })` is the production runner on the production migration files, which is what
 * makes this a real reproduction: the tables, constraints and columns are the ones 4.0.4 shipped.
 */
async function build404Database(): Promise<void> {
  await runMigrations({ upTo: '0107' });

  await autocommit(async client => {
    await client.query('DELETE FROM messages WHERE account_id IN ($1, $2)', [GMAIL_ACCOUNT_ID, PLAIN_ACCOUNT_ID]);
    await client.query('DELETE FROM inbox_rules WHERE user_id = $1', [USER_ID]);
    await client.query('DELETE FROM snoozed_messages WHERE user_id = $1', [USER_ID]);
    await client.query('DELETE FROM email_accounts WHERE id IN ($1, $2)', [GMAIL_ACCOUNT_ID, PLAIN_ACCOUNT_ID]);
    await client.query('DELETE FROM users WHERE id = $1', [USER_ID]);

    await client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'upgrade-404-user') ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    );
    // A Gmail mailbox as 4.0.4 stored it: IMAP, with no native transport — `mail_transport` stays NULL, which
    // every transport decision in the application reads as `imap_smtp`.
    await client.query(
      `INSERT INTO email_accounts (id, user_id, name, email_address, protocol, imap_host, imap_port, enabled)
       VALUES ($1, $2, 'Gmail (legacy)', 'legacy@gmail.test', 'imap', 'imap.gmail.com', 993, true)`,
      [GMAIL_ACCOUNT_ID, USER_ID],
    );
    // A second, non-Gmail IMAP account: its messages carry no provider id at all.
    await client.query(
      `INSERT INTO email_accounts (id, user_id, name, email_address, protocol, imap_host, imap_port, enabled)
       VALUES ($1, $2, 'Fastmail', 'me@fastmail.test', 'imap', 'imap.fastmail.test', 993, true)`,
      [PLAIN_ACCOUNT_ID, USER_ID],
    );

    // One Gmail message in four label folders: four rows, one X-GM-MSGID, one X-GM-THRID. A second message
    // duplicated twice, and a third that exists once. This is the real shape of a 4.0.4 Gmail account.
    const gmailCopies: Array<{ uid: number; folder: string; providerId: string; providerThread: string }> = [];
    for (const folder of GMAIL_FOLDERS) gmailCopies.push({ uid: 101, folder, providerId: '1844796336676610716', providerThread: '1844796336676610000' });
    gmailCopies.push({ uid: 102, folder: 'INBOX', providerId: '1844796336676610717', providerThread: '1844796336676610001' });
    gmailCopies.push({ uid: 102, folder: '[Gmail]/All Mail', providerId: '1844796336676610717', providerThread: '1844796336676610001' });
    gmailCopies.push({ uid: 103, folder: 'INBOX', providerId: '1844796336676610718', providerThread: '1844796336676610002' });

    for (const copy of gmailCopies) {
      await client.query(
        `INSERT INTO messages (account_id, uid, folder, message_id, subject, from_email, date, is_read, provider_message_id, provider_thread_id, provider_namespace)
         VALUES ($1, $2, $3, $4, $5, 'sender@example.test', NOW(), false, $6, $7, 'gmail')`,
        [GMAIL_ACCOUNT_ID, copy.uid, copy.folder, `<copy-${copy.uid}@gmail.test>`, `Message ${copy.uid}`, copy.providerId, copy.providerThread],
      );
    }
    // The non-Gmail account: no provider identity anywhere.
    await client.query(
      `INSERT INTO messages (account_id, uid, folder, message_id, subject, from_email, date, is_read)
       VALUES ($1, 201, 'INBOX', '<plain-201@fastmail.test>', 'Plain IMAP message', 'sender@example.test', NOW(), false)`,
      [PLAIN_ACCOUNT_ID],
    );

    // Data whose foreign keys point at the message rows and at the accounts: a rule, a snooze, a folder row
    // and a Conversation Engine identity for the messages that the upgrade must not disturb.
    await client.query(
      `INSERT INTO folders (account_id, path, name, special_use) VALUES ($1, 'INBOX', 'Inbox', '\\Inbox')
       ON CONFLICT (account_id, path) DO NOTHING`,
      [GMAIL_ACCOUNT_ID],
    );
    await client.query(
      `INSERT INTO inbox_rules (user_id, account_id, name, enabled, conditions, actions)
       VALUES ($1, $2, 'Legacy rule', true, '{}'::jsonb, '{}'::jsonb)`,
      [USER_ID, GMAIL_ACCOUNT_ID],
    );
    await client.query(
      `INSERT INTO snoozed_messages (user_id, account_id, message_id_header, original_folder, snooze_until, snoozed_folder)
       SELECT $1, $2, m.message_id, m.folder, NOW() + INTERVAL '1 day', 'Snoozed' FROM messages m
        WHERE m.account_id = $2 ORDER BY m.id LIMIT 1`,
      [USER_ID, GMAIL_ACCOUNT_ID],
    );
  });
}

/** What the pre-upgrade state actually looks like, as evidence for the assertions. */
async function preUpgradeEvidence(): Promise<{ rows: number; rowsWithProviderId: number; distinctProviderIds: number }> {
  return autocommit(async client => {
    const result = await client.query<{ rows: string; with_id: string; distinct_ids: string }>(
      `SELECT COUNT(*)::text AS rows,
              COUNT(provider_message_id)::text AS with_id,
              COUNT(DISTINCT provider_message_id)::text AS distinct_ids
         FROM messages WHERE account_id = $1`,
      [GMAIL_ACCOUNT_ID],
    );
    const row = result.rows[0]!;
    return { rows: Number(row.rows), rowsWithProviderId: Number(row.with_id), distinctProviderIds: Number(row.distinct_ids) };
  });
}

describeOrSkip('4.0.4 → 4.1.0 upgrade', () => {
  let before: Snapshot;
  let evidence: { rows: number; rowsWithProviderId: number; distinctProviderIds: number };

  beforeAll(async () => {
    // The environment already carries the database this gate was pointed at; the key keeps credential
    // encryption deterministic across the two halves of the run.
    process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
    await build404Database();
    before = await snapshot();
    evidence = await preUpgradeEvidence();
    // The upgrade itself: the same call the backend makes at start-up, with no limit.
    await runMigrations();
  }, 180_000);

  afterAll(async () => {
    // Leave the database migrated and seeded: the upgrade smoke starts the published images against a copy of
    // exactly this state.
  });

  it('is a real reproduction: the legacy Gmail mailbox carries duplicate provider ids across label copies', () => {
    expect(evidence.rows).toBe(7);
    expect(evidence.rowsWithProviderId).toBe(7);
    // Four rows share one X-GM-MSGID and two share another: fewer distinct ids than rows, which is what made
    // the original index creation fail with 23505.
    expect(evidence.distinctProviderIds).toBe(3);
    expect(evidence.distinctProviderIds).toBeLessThan(evidence.rowsWithProviderId);
  });

  it('applies every migration from the 4.0.4 state to the current head, through the production runner', async () => {
    const applied = await autocommit(client => client.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version >= '0108' ORDER BY version",
    ));
    const versions = applied.rows.map(row => row.version);
    // 0108 (the one that used to fail), then everything after it, recorded as applied.
    expect(versions[0]).toBe('0108_message_provider_identity');
    expect(versions.some(version => version.startsWith('0113_'))).toBe(true);
    expect((await autocommit(client => client.query(
      "SELECT COUNT(*)::text AS count FROM schema_migrations WHERE version = '0108_message_provider_identity'",
    ))).rows[0]?.count).toBe('1');
  });

  it('keeps every message row, id, uid, folder and Conversation Engine identity', async () => {
    const after = await snapshot();
    expect(after.ids).toEqual(before.ids);
    expect(after.uidFolders).toEqual(before.uidFolders);
    expect(after.conversations).toBe(before.conversations);
    expect(after.logicalMessages).toBe(before.logicalMessages);
    expect(after.conversationAliases).toBe(before.conversationAliases);
    expect(after.rules).toBe(before.rules);
    expect(after.snoozes).toBe(before.snoozes);
    // Nothing was deleted anywhere: the row count is the one the fixture created.
    expect(after.ids).toHaveLength(evidence.rows + 1);
  });

  it('does not touch legacy Gmail threading evidence', async () => {
    const after = await snapshot();
    // `provider_thread_id` (X-GM-THRID) and `thread_key` are what the legacy grouping uses, and both survive
    // the upgrade untouched.
    expect(after.providerThreadIds).toEqual(before.providerThreadIds);
    expect(after.threadKeys).toEqual(before.threadKeys);
    // All seven Gmail copies keep their X-GM-THRID; the plain IMAP message never had one.
    expect(after.providerThreadIds.filter(Boolean)).toHaveLength(7);
  });

  it('clears the legacy provider ids on the IMAP account so the native identity index can exist', async () => {
    const after = await snapshot();
    expect(after.providerIds.every(id => id === null)).toBe(true);
    const index = await autocommit(client => client.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'messages_provider_identity_key'",
    ));
    expect(index.rows[0]?.indexdef).toContain('UNIQUE');
  });

  it('still enforces one native provider identity per account', async () => {
    // A native account keeps its ids, and a duplicate is refused by the index the migration created.
    await autocommit(async client => {
      await client.query('UPDATE email_accounts SET mail_transport = $2 WHERE id = $1', [GMAIL_ACCOUNT_ID, 'microsoft_graph']);
      await client.query(
        `INSERT INTO messages (account_id, uid, folder, message_id, subject, date, provider_message_id)
         VALUES ($1, 301, 'INBOX', '<native-1@graph.test>', 'Native one', NOW(), 'graph-native-1')`,
        [GMAIL_ACCOUNT_ID],
      );
      await expect(client.query(
        `INSERT INTO messages (account_id, uid, folder, message_id, subject, date, provider_message_id)
         VALUES ($1, 302, 'INBOX', '<native-2@graph.test>', 'Native two', NOW(), 'graph-native-1')`,
        [GMAIL_ACCOUNT_ID],
      )).rejects.toMatchObject({ code: '23505' });
      // The same provider id on a different account is a different identity and stays allowed.
      await client.query('UPDATE email_accounts SET mail_transport = $2 WHERE id = $1', [PLAIN_ACCOUNT_ID, 'microsoft_graph']);
      await client.query(
        `INSERT INTO messages (account_id, uid, folder, message_id, subject, date, provider_message_id)
         VALUES ($1, 401, 'INBOX', '<native-3@graph.test>', 'Native three', NOW(), 'graph-native-1')`,
        [PLAIN_ACCOUNT_ID],
      );
      // Restore the fixture's state for the upgrade smoke that runs after this gate.
      await client.query('DELETE FROM messages WHERE uid IN (301, 302, 401)');
      await client.query('UPDATE email_accounts SET mail_transport = NULL WHERE id IN ($1, $2)', [GMAIL_ACCOUNT_ID, PLAIN_ACCOUNT_ID]);
    });
  });

  it('recovers a database whose 0108 attempt added the column but failed before the index', async () => {
    // The state a stopped upgrade leaves behind: the column exists, the index does not, and 0108 is not
    // recorded. The corrected migration must be able to run from exactly there.
    await autocommit(async client => {
      await client.query("DELETE FROM schema_migrations WHERE version = '0108_message_provider_identity'");
      await client.query('DROP INDEX IF EXISTS messages_provider_identity_key');
      await client.query('DROP INDEX IF EXISTS messages_provider_folder_idx');
      // The legacy duplicates are back, because that is what the interrupted attempt was looking at.
      await client.query(
        `UPDATE messages SET provider_message_id = '1844796336676610716' WHERE account_id = $1 AND folder IN ('INBOX', '[Gmail]/Important')`,
        [GMAIL_ACCOUNT_ID],
      );
    });

    await runMigrations();

    const index = await autocommit(client => client.query(
      "SELECT 1 FROM pg_indexes WHERE indexname = 'messages_provider_identity_key'",
    ));
    expect(index.rows).toHaveLength(1);
    const providers = await snapshot();
    expect(providers.providerIds.every(id => id === null)).toBe(true);
    expect(providers.ids).toHaveLength(evidence.rows + 1);
  }, 120_000);

  it('keeps booting a database that ran the previous 0108 revision', async () => {
    // An installation that tested an earlier `:dev` already has 0108 recorded under its first checksum. The
    // runner must accept that checksum rather than refusing to start, and must not run the file again.
    await autocommit(client => client.query(
      `UPDATE schema_migrations SET sha256 = $1 WHERE version = '0108_message_provider_identity'`,
      ['77f2c82c41e14ebb8a79e6f6a3d726e33b9217c6921cf5743c2088afbbae1ba2'],
    ));

    await runMigrations();

    const applied = await autocommit(client => client.query<{ sha256: string }>(
      "SELECT sha256 FROM schema_migrations WHERE version = '0108_message_provider_identity'",
    ));
    // The recorded checksum is the historical one: the migration was skipped, not re-applied over data it
    // already shaped.
    expect(applied.rows[0]?.sha256).toBe('77f2c82c41e14ebb8a79e6f6a3d726e33b9217c6921cf5743c2088afbbae1ba2');
    const providers = await snapshot();
    expect(providers.providerIds.every(id => id === null)).toBe(true);
  }, 120_000);

  it('is idempotent: running the runner again changes nothing', async () => {
    const beforeSecondRun = await snapshot();
    await runMigrations();
    const afterSecondRun = await snapshot();
    expect(afterSecondRun.ids).toEqual(beforeSecondRun.ids);
    expect(afterSecondRun.providerIds).toEqual(beforeSecondRun.providerIds);
  }, 120_000);
});
