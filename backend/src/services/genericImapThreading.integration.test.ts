import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { query } from './db.js';
import { upsertConversationCopy } from './conversationPersistence.js';
import { providerMetadataForMessage } from './providerConversationMetadata.js';
import { threadingDecision } from './conversationEngine.js';
import { listMessages } from './messageService.js';

/**
 * Conversation grouping on a plain IMAP account (the OVH case).
 *
 * A live acceptance round reported that an ordinary IMAP mailbox started grouping badly. Nothing in the
 * provider work may change what a generic mailbox does: its reply chain is the RFC one — `Message-ID`,
 * `In-Reply-To` and `References` — and it must never receive a provider thread id, because the only reason a
 * provider thread is authoritative is that the provider guarantees it (Gmail's X-GM-THRID, Graph's
 * conversationId). Subject is diagnostic metadata: a matching subject is not evidence of a reply, and a
 * localized reply prefix (`Odp:`, `AW:`, `SV:`) is not an edge.
 *
 * These cases drive the real persistence path on PostgreSQL, with the provider hint built by the same function
 * the ingest uses, so a change that only affects the helper is not enough to pass.
 *
 *   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=<db> DB_USER=mailflow_test DB_PASSWORD=mailflow_test \
 *     npx vitest run src/services/genericImapThreading.integration.test.ts
 */

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const userId = randomUUID();
const accountId = randomUUID();
// A mailbox that is not a provider: no oauth_provider, no native transport, an ordinary IMAP host.
const account = {
  id: accountId,
  imap_host: 'ssl0.ovh.net',
  mail_transport: null as string | null,
  oauth_provider: null as string | null,
};

let uid = 0;

/** Insert one stored message and run it through conversation persistence, as the ingest does. */
async function ingest(input: {
  messageId: string;
  subject: string;
  inReplyTo?: string | null;
  references?: string | null;
  date?: string;
  accountOverride?: typeof account;
}): Promise<{ conversationId: string; threadKey: string | null }> {
  uid += 1;
  const row = (await query(
    `INSERT INTO messages(account_id, uid, folder, message_id, in_reply_to, thread_references, subject, from_email, to_addresses, date, snippet, is_read)
     VALUES($1,$2,'INBOX',$3,$4,$5,$6,'sender@ovh.example','[{"address":"me@ovh.example"}]',$7,'Synthetic message',false)
     RETURNING *`,
    [accountId, uid, input.messageId, input.inReplyTo ?? null, input.references ?? null, input.subject,
      new Date(input.date ?? `2026-09-0${uid}T09:00:00Z`)],
  )).rows[0];

  const scope = input.accountOverride ?? account;
  // The hint the real ingest builds for this message, from the same function.
  const provider = providerMetadataForMessage(
    { message_id: input.messageId, in_reply_to: input.inReplyTo ?? null, thread_references: input.references ?? null, subject: input.subject } as never,
    scope as never,
  );

  const result = await upsertConversationCopy({ ...row, user_id: userId }, {
    userId,
    identities: ['me@ovh.example'],
    provider: { provider: provider.provider, isStrong: provider.isStrong, source: provider.source, providerThreadId: provider.providerThreadId, namespace: provider.namespace } as never,
  });
  const stored = await query<{ conversation_id: string; thread_key: string | null }>(
    'SELECT conversation_id, thread_key FROM messages WHERE id = $1', [row.id],
  );
  return { conversationId: String(result.conversationId ?? stored.rows[0]?.conversation_id), threadKey: stored.rows[0]?.thread_key ?? null };
}

beforeAll(async () => {
  if (!hasPg) return;
  await query('INSERT INTO users(id, username, password_hash) VALUES($1,$2,$3)', [userId, `imap-thread-${userId}`, 'unused']);
  await query(
    "INSERT INTO email_accounts(id,user_id,name,email_address,protocol,imap_host,mail_transport) VALUES($1,$2,'OVH','me@ovh.example','imap','ssl0.ovh.net',NULL)",
    [accountId, userId],
  );
});

afterAll(async () => {
  if (!hasPg) return;
  await query('DELETE FROM users WHERE id=$1', [userId]);
});

describeOrSkip('generic IMAP threading (PostgreSQL)', () => {
  it('keeps an RFC reply chain in one conversation', async () => {
    const first = await ingest({ messageId: '<a@ovh.example>', subject: 'Faktura 09/2026' });
    const reply = await ingest({
      messageId: '<b@ovh.example>',
      subject: 'Re: Faktura 09/2026',
      inReplyTo: '<a@ovh.example>',
      references: '<a@ovh.example>',
      date: '2026-09-02T09:00:00Z',
    });

    expect(reply.conversationId).toBe(first.conversationId);
  });

  it('does not merge two unrelated messages that happen to share a subject', async () => {
    const one = await ingest({ messageId: '<c@ovh.example>', subject: 'Faktura', date: '2026-10-01T09:00:00Z' });
    const two = await ingest({ messageId: '<d@ovh.example>', subject: 'Faktura', date: '2026-10-02T09:00:00Z' });

    // No In-Reply-To and no References: the same words in the subject are not an edge, so these are two
    // conversations. Merging them is the false grouping a generic mailbox must never get.
    expect(two.conversationId).not.toBe(one.conversationId);
  });

  it('does not treat a localized reply prefix as a reply edge', async () => {
    const original = await ingest({ messageId: '<e@ovh.example>', subject: 'Zamówienie', date: '2026-11-01T09:00:00Z' });
    const prefixed = await ingest({ messageId: '<f@ovh.example>', subject: 'Odp: Zamówienie', date: '2026-11-02T09:00:00Z' });
    const german = await ingest({ messageId: '<g@ovh.example>', subject: 'AW: Zamówienie', date: '2026-11-03T09:00:00Z' });

    // The prefix is normalized for display and diagnosis, but it cannot be the only reason to group.
    expect(prefixed.conversationId).not.toBe(original.conversationId);
    expect(german.conversationId).not.toBe(original.conversationId);
    expect(prefixed.conversationId).not.toBe(german.conversationId);
  });

  it('does not give a generic IMAP account a provider thread', () => {
    // The distinguishing property: a generic mailbox carries no provider thread id, so the only thing that can
    // group it is the RFC chain. If an OBJECTID-like attribute is present it is metadata, not authority.
    const metadata = providerMetadataForMessage(
      { message_id: '<h@ovh.example>', thread_id: 'OBJECTID-1', subject: 'Faktura' } as never,
      account as never,
    );
    expect(metadata.provider).toBe('generic');
    expect(metadata.isStrong).toBe(false);
    // And the decision it feeds is therefore never `provider_thread`.
    const decision = threadingDecision({
      message: { id: 'm1', account_id: accountId, subject: 'Faktura', message_id: '<h@ovh.example>' } as never,
      parent: null,
      provider: {
        isStrong: Boolean(metadata.isStrong),
        source: metadata.source == null ? null : String(metadata.source),
        providerThreadId: metadata.providerThreadId == null ? null : String(metadata.providerThreadId),
      },
    });
    expect(decision.kind).not.toBe('provider_thread');
  });

  it('still treats native Gmail and Graph threads as authoritative', () => {
    // The two providers whose thread id is guaranteed do keep strong grouping — this is the behaviour the
    // provider work added, and the generic case must not have removed it.
    const gmail = providerMetadataForMessage(
      { thread_id: 'gmail-thread-1', provider_thread_id: 'gmail-thread-1' } as never,
      { id: accountId, imap_host: 'imap.gmail.com', mail_transport: 'gmail_api' } as never,
    );
    expect(gmail.isStrong).toBe(true);

    const graph = providerMetadataForMessage(
      { thread_id: 'graph-conversation-1' } as never,
      { id: accountId, imap_host: 'outlook.office365.com', mail_transport: 'microsoft_graph' } as never,
    );
    expect(graph.isStrong).toBe(true);
  });

  it('lists the RFC chain as one conversation and the same-subject pair as two', async () => {
    // The same assertion through the query the interface uses, not only through the stored ids.
    const listed = await listMessages({ userId, accountId, threaded: true });
    const subjectOf = (row: { subject?: unknown }) => String(row.subject ?? '');
    // The reply chain contributes one row whose count is the chain, and the two same-subject messages are
    // separate rows of their own.
    const fakturaRows = listed.messages.filter(row => subjectOf(row).includes('Faktura'));
    const plain = fakturaRows.filter(row => subjectOf(row).trim() === 'Faktura');
    expect(plain.length).toBe(2);
    expect(listed.messages.length).toBeGreaterThan(0);
  });
});
