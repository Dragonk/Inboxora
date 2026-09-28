import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledRow } from './scheduledMail.js';
import type { ComposedMail } from './composedMail.js';
import type { MailTransport } from './sendTransport.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), get: vi.fn(), set: vi.fn(), eval: vi.fn(),
  bind: vi.fn(), fetchAttachment: vi.fn(),
  send: vi.fn<MailTransport['send']>(),
  preflight: vi.fn<(mail: ComposedMail) => null>(),
}));
const queue = vi.hoisted(() => ({
  claimScheduledMail: vi.fn(), completeScheduledMail: vi.fn(), recoverScheduledMail: vi.fn(),
  renewScheduledClaim: vi.fn(), beginScheduledDispatch: vi.fn(), releaseScheduledClaim: vi.fn(),
}));
vi.mock('./scheduledMail.js', () => queue);
vi.mock('./db.js', () => ({ query: mocks.query, withTransaction: vi.fn() }));
vi.mock('./redis.js', () => ({ redisClient: { get: mocks.get, set: mocks.set, eval: mocks.eval } }));
vi.mock('../index.js', () => ({ imapManager: { fetchAttachment: mocks.fetchAttachment } }));
vi.mock('./sendTransport.js', () => ({ createAccountMailTransport: mocks.bind, transportKindForAccount: () => 'smtp' }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn() } }));

import { createScheduledMailWorker } from './scheduledMailWorker.js';
import { executeSend, type SendRequestBody } from './sendMail.js';

const accountId = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const messageId = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const userId = 'test-user';
const account = { id: accountId, email_address: 'owner@example.test', name: 'Owner', signature: '<p>Original signature</p>' };
let signature: string | null;
let aliasEmail: string;
let sourceAvailable: boolean;
const body: SendRequestBody = {
  accountId, to: ['To Person <to@example.test>'], cc: ['cc@example.test'], bcc: ['private@example.test'],
  subject: 'Prepared mail', body: 'Hello', bodyIsHtml: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  signature = account.signature;
  aliasEmail = 'alias@example.test';
  sourceAvailable = true;
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM email_accounts')) return { rows: [{ ...account, signature }] };
    if (sql.includes('SELECT preferences FROM users')) return { rows: [{ preferences: {} }] };
    if (sql.includes('FROM account_aliases')) return { rows: [{ name: 'Alias', email: aliasEmail, signature: null }] };
    if (sql.includes('FROM messages m') && sql.includes('m.id = ANY')) return { rows: sourceAvailable ? [{
      id: messageId, uid: 5, folder: 'INBOX', account_id: accountId,
      attachments: [{ part: '2', filename: 'source.bin', type: 'application/octet-stream', size: 4 }],
    }] : [] };
    if (sql.includes('INSERT INTO send_idempotency')) return { rows: [{ status: 'pending' }] };
    if (sql.includes('DELETE FROM send_idempotency')) return { rows: [], rowCount: 1 };
    if (sql.includes('UPDATE send_idempotency')) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected SQL in send preparation test: ${sql}`);
  });
  mocks.get.mockResolvedValue(null);
  mocks.set.mockResolvedValue('OK');
  mocks.eval.mockResolvedValue(1);
  mocks.preflight.mockReturnValue(null);
  mocks.bind.mockResolvedValue({ account, transport: {
    kind: 'smtp', sendsRenderedMessage: true, send: mocks.send, preflight: mocks.preflight,
  } });
  // A fake definite refusal exercises dispatch without post-delivery tasks or real mail.
  mocks.send.mockResolvedValue({ status: 'refused', statusCode: 422, code: 'TEST_REFUSAL', error: 'Fake transport refusal', retryable: false });
  mocks.fetchAttachment.mockResolvedValue(Buffer.from([0, 255, 10, 128]));
});

function expectNoDeliveryClaims() {
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.set).not.toHaveBeenCalled();
  expect(mocks.eval).not.toHaveBeenCalled();
  expect(mocks.query.mock.calls.filter(([sql]) => /(?:INSERT INTO|UPDATE|DELETE FROM) send_idempotency/.test(String(sql)))).toEqual([]);
}

describe('executeSend preparation boundary', () => {
  it('renders and validates a snapshot before any durable intent, reservation or dispatch callback', async () => {
    const beforeDispatch = vi.fn(async () => true);
    const result = await executeSend(userId, body, 'prepare-key', { prepareOnly: true, beforeDispatch });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(result.prepared).toMatchObject({ senderEmail: account.email_address, payload: {
      to: body.to, cc: body.cc, bcc: body.bcc, editedSignature: account.signature,
      editedSignatureIsHtml: true, forwardedAttachments: [], attachments: [],
    } });
    expect(mocks.preflight).toHaveBeenCalledOnce();
    expect(mocks.preflight.mock.calls[0][0].plainBody).toContain('Original signature');
    expect(beforeDispatch).not.toHaveBeenCalled();
    expectNoDeliveryClaims();
  });

  it('materializes forwarded bytes alongside uploads and can execute after the source disappears', async () => {
    const uploaded = { filename: 'upload.txt', content: Buffer.from('upload').toString('base64'), contentType: 'text/plain' };
    const result = await executeSend(userId, { ...body, attachments: [uploaded], forwardedAttachments: [{ messageId, part: '2' }] }, null, { prepareOnly: true });
    expect(result.status).toBe(200);
    const prepared = result.prepared;
    expect(prepared).toBeDefined();
    if (!prepared) throw new Error('Expected a prepared snapshot');
    expect(prepared.payload.attachments).toEqual([uploaded, {
      filename: 'source.bin', content: Buffer.from([0, 255, 10, 128]).toString('base64'), contentType: 'application/octet-stream',
    }]);
    expect(prepared.payload.forwardedAttachments).toEqual([]);
    expect(mocks.fetchAttachment).toHaveBeenCalledOnce();
    sourceAvailable = false;
    mocks.query.mockClear();
    const dispatched = await executeSend(userId, prepared.payload, null, { expectedSenderEmail: prepared.senderEmail });
    expect(dispatched.status).toBe(422);
    expect(mocks.fetchAttachment).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('FROM messages m'))).toBe(false);
    const sentAttachments = mocks.send.mock.calls[0][0].composed.attachments;
    expect(sentAttachments).toHaveLength(2);
    if (!sentAttachments) throw new Error('Expected materialized attachments');
    expect(sentAttachments.map(a => a.content)).toEqual([Buffer.from('upload'), Buffer.from([0, 255, 10, 128])]);
  });

  it.each([100, 101])('enforces the combined uploaded and forwarded attachment count at %i', async (total) => {
    const attachments = Array.from({ length: total - 1 }, (_, index) => ({
      filename: `upload-${index}.txt`, content: Buffer.from('x').toString('base64'), contentType: 'text/plain',
    }));
    const result = await executeSend(userId, {
      ...body, attachments, forwardedAttachments: [{ messageId, part: '2' }],
    }, 'combined-attachment-limit', { prepareOnly: true });
    if (total === 100) {
      expect(result.status).toBe(200);
      expect(result.prepared?.payload.attachments).toHaveLength(100);
    } else {
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('SCHEDULE_ATTACHMENTS_LIMIT');
      expect(result.prepared).toBeUndefined();
    }
    expectNoDeliveryClaims();
  });

  it('freezes inferred forward intent when materializing its source references', async () => {
    const result = await executeSend(userId, {
      ...body, forwardedAttachments: [{ messageId, part: '2' }],
    }, null, { prepareOnly: true });
    expect(result.status).toBe(200);
    if (!result.prepared) throw new Error('Expected a prepared snapshot');
    expect(result.prepared.payload.sendKind).toBe('forward');
    expect(result.prepared.payload.forwardedAttachments).toEqual([]);
    expect(result.prepared.payload.attachments).toHaveLength(1);
    const repeatedPreparation = await executeSend(userId, result.prepared.payload, null, { prepareOnly: true });
    expect(repeatedPreparation.status).toBe(200);
    expect(repeatedPreparation.prepared?.payload.sendKind).toBe('forward');
    expect(mocks.fetchAttachment).toHaveBeenCalledOnce();
    expectNoDeliveryClaims();
  });

  it('preserves omitted sendKind for legacy headers-only replies through preparation and dispatch', async () => {
    const result = await executeSend(userId, {
      ...body, inReplyTo: '<legacy-parent@example.test>', references: '<ancestor@example.test> <legacy-parent@example.test>',
    }, null, { prepareOnly: true });
    expect(result.status).toBe(200);
    if (!result.prepared) throw new Error('Expected a prepared snapshot');
    expect(result.prepared.payload).not.toHaveProperty('sendKind');
    expect(result.prepared.payload.inReplyTo).toBe('<legacy-parent@example.test>');
    expect(result.prepared.payload.references).toBe('<ancestor@example.test> <legacy-parent@example.test>');
    const dispatched = await executeSend(userId, result.prepared.payload, null);
    expect(dispatched.status).toBe(422);
    expect(dispatched.body.code).toBe('TEST_REFUSAL');
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send.mock.calls[0][0].composed.inReplyTo).toBe('<legacy-parent@example.test>');
    expect(mocks.send.mock.calls[0][0].composed.references).toBe('<ancestor@example.test> <legacy-parent@example.test>');
  });

  it('retains BCC solely in the private recipient list and envelope, never visible MIME headers', async () => {
    const result = await executeSend(userId, body, null, { prepareOnly: true });
    if (!result.prepared) throw new Error('Expected a prepared snapshot');
    expect(result.prepared.payload.to).toEqual(body.to);
    expect(result.prepared.payload.cc).toEqual(body.cc);
    expect(result.prepared.payload.bcc).toEqual(body.bcc);
    await executeSend(userId, result.prepared.payload, null);
    const { composed, rendered } = mocks.send.mock.calls[0][0];
    expect(composed.to).toEqual([{ name: 'To Person', email: 'to@example.test' }]);
    expect(composed.cc.map(recipient => recipient.email)).toEqual(['cc@example.test']);
    expect(composed.bcc.map(recipient => recipient.email)).toEqual(['private@example.test']);
    expect(rendered).toBeDefined();
    expect(rendered?.raw.toString()).not.toContain('private@example.test');
    expect(rendered?.raw.toString()).not.toMatch(/^bcc:/im);
    expect(rendered?.envelope.to).toContain('private@example.test');
  });

  it.each([undefined, '', 'Edited signature'])('freezes the signature override %s across account changes', async (override) => {
    const result = await executeSend(userId, { ...body, ...(override === undefined ? {} : { editedSignature: override, editedSignatureIsHtml: false }) }, null, { prepareOnly: true });
    if (!result.prepared) throw new Error('Expected a prepared snapshot');
    expect(result.prepared.payload.editedSignature).toBe(override ?? account.signature);
    signature = '<p>Changed after scheduling</p>';
    await executeSend(userId, result.prepared.payload, null, { expectedSenderEmail: result.prepared.senderEmail });
    const composed = mocks.send.mock.calls[0][0].composed;
    expect(composed.plainBody).not.toContain('Changed after scheduling');
    expect(composed.plainBody).toBe(override === '' ? 'Hello' : `Hello\n\n-- \n${override ?? 'Original signature'}`);
  });

  it('freezes the absence of a signature rather than adopting a later account default', async () => {
    signature = null;
    const result = await executeSend(userId, body, null, { prepareOnly: true });
    if (!result.prepared) throw new Error('Expected a prepared snapshot');
    expect(result.prepared.payload.editedSignature).toBe('');
    signature = '<p>Added later</p>';
    await executeSend(userId, result.prepared.payload, null);
    expect(mocks.send.mock.calls[0][0].composed.plainBody).toBe('Hello');
  });

  it('does not prepare or claim delivery when a forwarded source is no longer available', async () => {
    sourceAvailable = false;
    const result = await executeSend(userId, { ...body, forwardedAttachments: [{ messageId, part: '2' }] }, 'missing-source', { prepareOnly: true });
    expect(result.status).toBe(404);
    expect(result.body.code).toBe('RESOURCE_NOT_FOUND');
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE m\.id = ANY\(\$1::uuid\[\]\) AND a\.user_id = \$2/), [[messageId], userId],
    );
    expect(result.prepared).toBeUndefined();
    expect(mocks.fetchAttachment).not.toHaveBeenCalled();
    expectNoDeliveryClaims();
  });

  it('refuses a changed selected alias before claiming or submitting the frozen payload', async () => {
    const result = await executeSend(userId, { ...body, aliasId: 'selected-alias' }, null, { prepareOnly: true });
    if (!result.prepared) throw new Error('Expected a prepared snapshot');
    expect(result.prepared.senderEmail).toBe('alias@example.test');
    aliasEmail = 'different@example.test';
    const refused = await executeSend(userId, result.prepared.payload, 'scheduled-send-key', { expectedSenderEmail: result.prepared.senderEmail });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('SCHEDULE_SENDER_CHANGED');
    expectNoDeliveryClaims();
  });

  it('releases exactly its own SQL and Redis reservation when the final dispatch guard rejects ownership', async () => {
    const beforeDispatch = vi.fn(async () => false);
    const result = await executeSend(userId, body, 'guarded-key', { beforeDispatch });
    expect(result).toMatchObject({ status: 409, dispatchPrevented: true, body: { code: 'SEND_DISPATCH_PREVENTED' } });
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(mocks.send).not.toHaveBeenCalled();
    const claim = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO send_idempotency'));
    const release = mocks.query.mock.calls.find(([sql]) => String(sql).includes('DELETE FROM send_idempotency'));
    expect(claim).toBeDefined();
    expect(release).toBeDefined();
    const token: unknown = claim?.[1][3];
    expect(token).toEqual(expect.any(String));
    expect(release?.[0]).toContain('intent_token = $3::uuid');
    expect(release?.[1]).toEqual([userId, 'guarded-key', token]);
    expect(mocks.set).toHaveBeenCalledWith('send_idem:test-user:guarded-key', `__inflight__:${String(token)}`, { NX: true, EX: 300 });
    expect(mocks.eval).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("redis.call('DEL'"), {
      keys: ['send_idem:test-user:guarded-key'], arguments: [`__inflight__:${String(token)}`],
    });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("status = 'uncertain'"))).toBe(false);
  });
});

/** Pause an async boundary until the test has stopped the worker. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** Provide a frozen queue claim to the real worker and send pipeline. */
function scheduledClaim(): ScheduledRow {
  return {
    id: messageId, accountId, user_id: userId, subject: body.subject ?? '',
    mode: 'schedule', state: 'preparing', scheduledAt: new Date(), timeZone: 'UTC',
    revision: 3, errorCode: null, lease_token: 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3',
    request_fingerprint: 'original', edit_fingerprint: null,
    payload: { senderEmail: account.email_address, payload: body },
  };
}

describe('scheduled worker with real executeSend', () => {
  beforeEach(() => {
    queue.claimScheduledMail.mockResolvedValue(null);
    queue.recoverScheduledMail.mockResolvedValue(undefined);
    queue.releaseScheduledClaim.mockResolvedValue(undefined);
    queue.completeScheduledMail.mockResolvedValue(undefined);
    queue.renewScheduledClaim.mockResolvedValue(true);
    queue.beginScheduledDispatch.mockResolvedValue(true);
  });

  it.each(['preparation', 'final database gate'])('releases unsent SQL, Redis and queue claims after stop during %s', async boundary => {
    const claimed = scheduledClaim();
    queue.claimScheduledMail.mockResolvedValueOnce(claimed);
    const entered = deferred<void>();
    const resume = deferred<void>();
    if (boundary === 'preparation') {
      const binding = { account, transport: {
        kind: 'smtp', sendsRenderedMessage: true, send: mocks.send, preflight: mocks.preflight,
      } };
      mocks.bind.mockImplementationOnce(async () => { entered.resolve(); await resume.promise; return binding; });
    } else {
      queue.beginScheduledDispatch.mockImplementationOnce(async () => { entered.resolve(); await resume.promise; return true; });
    }
    const worker = createScheduledMailWorker();
    const running = worker.tick();
    await entered.promise;
    const stopping = worker.stop();
    resume.resolve();
    await Promise.all([running, stopping]);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(queue.beginScheduledDispatch).toHaveBeenCalledTimes(boundary === 'preparation' ? 0 : 1);
    expect(queue.releaseScheduledClaim).toHaveBeenCalledExactlyOnceWith(claimed);
    expect(queue.completeScheduledMail).not.toHaveBeenCalled();
    const key = `scheduled:${claimed.id}:${claimed.revision}`;
    const claim = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO send_idempotency'));
    const token: unknown = claim?.[1][3];
    expect(token).toEqual(expect.any(String));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringMatching(/DELETE FROM send_idempotency[\s\S]*intent_token = \$3::uuid/), [userId, key, token]);
    expect(mocks.set).toHaveBeenCalledWith(`send_idem:${userId}:${key}`, `__inflight__:${String(token)}`, { NX: true, EX: 300 });
    expect(mocks.eval).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("redis.call('DEL'"), {
      keys: [`send_idem:${userId}:${key}`], arguments: [`__inflight__:${String(token)}`],
    });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("status = 'uncertain'"))).toBe(false);
  });

  it('never releases the queue after an actual transport reports an unknown outcome', async () => {
    const claimed = scheduledClaim();
    queue.claimScheduledMail.mockResolvedValueOnce(claimed);
    mocks.send.mockResolvedValueOnce({ status: 'outcome_unknown', reason: 'Connection lost after submission' });
    const worker = createScheduledMailWorker();
    try {
      await worker.tick();
      expect(mocks.send).toHaveBeenCalledOnce();
      expect(queue.beginScheduledDispatch).toHaveBeenCalledExactlyOnceWith(claimed);
      expect(queue.releaseScheduledClaim).not.toHaveBeenCalled();
      expect(queue.completeScheduledMail).toHaveBeenCalledExactlyOnceWith(claimed,
        expect.objectContaining({ status: 502, body: expect.objectContaining({ code: 'SEND_OUTCOME_UNKNOWN' }) }));
      expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM send_idempotency'))).toBe(false);
      expect(mocks.eval.mock.calls.some(([script]) => String(script).includes("redis.call('DEL'"))).toBe(false);
    } finally { await worker.stop(); }
  });
});
