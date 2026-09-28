import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailTransport } from './sendTransport.js';
import type { SendRequestBody } from './sendMail.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), fetchAttachment: vi.fn(), bind: vi.fn(), send: vi.fn<MailTransport['send']>(),
  get: vi.fn(), set: vi.fn(), eval: vi.fn(),
}));
vi.mock('./db.js', () => ({ query: mocks.query, withTransaction: async (run: (client: { query: typeof mocks.query }) => Promise<unknown>) => run({ query: mocks.query }) }));
vi.mock('./redis.js', () => ({ redisClient: { get: mocks.get, set: mocks.set, eval: mocks.eval } }));
vi.mock('../index.js', () => ({ imapManager: { fetchAttachment: mocks.fetchAttachment } }));
vi.mock('./sendTransport.js', () => ({ createAccountMailTransport: mocks.bind, transportKindForAccount: () => 'smtp' }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn() } }));

import { enqueueMailMerge } from './scheduledMail.js';
import { executeSend } from './sendMail.js';

const userId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const sourceId = '33333333-3333-4333-8333-333333333333';
const account = { id: accountId, email_address: 'sender@example.test', name: 'Sender', signature: '<p>Frozen signature</p>' };
const addresses = ['first@example.test', 'second@example.test', 'third@example.test'];
const forwarded = Buffer.from([0, 255, 10, 128]);
const message: SendRequestBody = {
  accountId, to: [addresses[0]], cc: [addresses[1]], bcc: [addresses[2]],
  subject: 'Private copies', body: 'Hello', bodyIsHtml: false,
  forwardedAttachments: [{ messageId: sourceId, part: '2' }],
};
let sender = account.email_address;
let signature = account.signature;
let sourceAvailable = true;
let stored: { id: string; payload: { payload: SendRequestBody; senderEmail: string } }[];

beforeEach(() => {
  vi.resetAllMocks(); stored = []; sender = account.email_address; signature = account.signature; sourceAvailable = true;
  mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM mail_merge_batches')) return { rows: [] };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('SELECT count(*) FROM scheduled_mail')) return { rows: [{ count: '0' }] };
    if (sql.includes('SELECT preferences FROM users')) return { rows: [{ preferences: { undoSendSeconds: 0 } }] };
    if (sql.includes('FROM users WHERE id =')) return { rows: [{ preferences: {} }] };
    if (sql.includes('FROM email_accounts WHERE id =')) return { rows: [{ ...account, email_address: sender, signature }] };
    if (sql.includes('FROM email_accounts a WHERE a.id=')) {
      const row = { id: params[0] as string, payload: JSON.parse(params[7] as string) as { payload: SendRequestBody; senderEmail: string } };
      stored.push(row); return { rows: [{ id: row.id }] };
    }
    if (sql.includes('FROM messages m') && sql.includes('m.id = ANY')) return { rows: sourceAvailable ? [{
      id: sourceId, uid: 5, folder: 'INBOX', account_id: accountId,
      attachments: [{ part: '2', filename: 'source.bin', type: 'application/octet-stream', size: forwarded.length }],
    }] : [] };
    if (sql.startsWith('UPDATE scheduled_mail SET scheduled_at=')) return { rows: [], rowCount: stored.length };
    if (sql.includes('INSERT INTO mail_merge_batches')) return { rows: [] };
    if (sql.includes('FROM scheduled_mail') && sql.includes('array_position')) return { rows: stored.map(row => ({
      id: row.id, accountId, subject: 'Private copies', mode: 'undo', state: 'pending', scheduledAt: new Date(),
      timeZone: 'UTC', revision: 1, errorCode: null,
    })) };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  mocks.bind.mockImplementation(async () => ({ account, transport: {
    kind: 'smtp', sendsRenderedMessage: true, send: mocks.send, preflight: () => null,
  } }));
  // A definite fake refusal exercises real MIME construction without sending mail.
  mocks.send.mockResolvedValue({ status: 'refused', statusCode: 422, code: 'TEST_REFUSAL', error: 'Fake refusal', retryable: false });
  mocks.fetchAttachment.mockResolvedValue(forwarded);
  mocks.get.mockResolvedValue(null); mocks.set.mockResolvedValue('OK'); mocks.eval.mockResolvedValue(1);
});

describe('mail merge through real preparation and fake SMTP dispatch', () => {
  it('freezes one source and produces three independently addressed messages', async () => {
    const receipt = await enqueueMailMerge(userId, { message }, 'privacy-key', executeSend);
    expect(receipt.count).toBe(3); expect(stored).toHaveLength(3);
    expect(mocks.fetchAttachment).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes('FROM messages m'))).toHaveLength(1);
    expect(stored.map(row => row.payload.payload.to?.[0])).toEqual(addresses);
    expect(stored.map(row => row.payload.senderEmail)).toEqual(Array(3).fill(account.email_address));
    sourceAvailable = false; signature = '<p>Changed later</p>';
    for (const row of stored) {
      const result = await executeSend(userId, row.payload.payload, null, { expectedSenderEmail: row.payload.senderEmail });
      expect(result.status).toBe(422);
    }
    expect(mocks.fetchAttachment).toHaveBeenCalledOnce();
    const sent = mocks.send.mock.calls.map(([input]) => input);
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map(item => item.composed.messageId)).size).toBe(3);
    for (const [index, { composed, rendered }] of sent.entries()) {
      expect(composed.to.map(person => person.email)).toEqual([addresses[index]]);
      expect(composed.cc).toEqual([]); expect(composed.bcc).toEqual([]);
      expect(rendered?.envelope.to).toEqual([addresses[index]]);
      const raw = rendered?.raw.toString() ?? '';
      for (const [otherIndex, address] of addresses.entries()) {
        if (otherIndex !== index) expect(raw).not.toContain(address);
      }
      expect(composed.plainBody).toContain('Frozen signature');
      expect(composed.plainBody).not.toContain('Changed later');
      expect(composed.attachments?.map(item => item.content)).toEqual([forwarded]);
      expect(composed.from.email).toBe(account.email_address);
    }
    expect(new Set(sent.map(item => item.composed.plainBody)).size).toBe(1);
  });

  it('rejects a sender change during batch preparation before storing any child', async () => {
    mocks.bind.mockImplementation(async () => {
      sender = 'changed@example.test';
      return { account, transport: { kind: 'smtp', sendsRenderedMessage: true, send: mocks.send, preflight: () => null } };
    });
    // Sender identity must change after the first preparation, before the second.
    mocks.fetchAttachment.mockImplementationOnce(async () => { sender = 'changed@example.test'; return forwarded; });
    await expect(enqueueMailMerge(userId, { message }, 'sender-key', executeSend))
      .rejects.toMatchObject({ code: 'SCHEDULE_SENDER_CHANGED' });
    expect(stored).toEqual([]); expect(mocks.send).not.toHaveBeenCalled();
  });
});
