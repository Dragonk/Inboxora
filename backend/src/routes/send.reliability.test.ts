import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { JsonBody } from '../test/json.js';
import { parseRawHeaders } from '../services/messageParser.js';
vi.mock('../services/db.js', () => ({
  query: vi.fn(),
  // Delivery tests must model the transaction used by asynchronous recipient
  // learning so expected transport outcomes do not emit unrelated mock errors.
  withTransaction: async (work: (client: { query: (sql: string) => Promise<{ rows: Array<{ contact_id?: string }>; rowCount?: number }> }) => Promise<unknown>) => work({
    query: async sql => sql.includes('SELECT contact_id')
      ? { rows: [{ contact_id: 'learned-contact' }], rowCount: 1 }
      : { rows: [], rowCount: 1 },
  }),
}));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/redis.js', () => ({ redisClient: { get: vi.fn(), set: vi.fn(), del: vi.fn(), eval: vi.fn() } }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));
import express from 'express';
import routes from './send.js';
import { query as __mock_query } from '../services/db.js';
import { redisClient as __mock_redisClient } from '../services/redis.js';
import { createAccountSmtpTransport as __mock_createAccountSmtpTransport } from '../services/smtpTransport.js';
import { resolveSentFolder as __mock_resolveSentFolder } from '../utils/mailUtils.js';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

// Cast mocked module exports so their vitest mock helpers type-check.
const query = vi.mocked(__mock_query);
const redisClient = vi.mocked(__mock_redisClient);
const createAccountSmtpTransport = vi.mocked(__mock_createAccountSmtpTransport);
const resolveSentFolder = vi.mocked(__mock_resolveSentFolder);

const account = { id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: 'google' };
const sendMail = vi.fn();
let server: Server, base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks();
  query.mockImplementation(async sql => {
    if (sql.includes('FROM messages m JOIN email_accounts')) {
      return { rows: [{ id: 'parent-row', message_id: '<parent@example.com>', canonical_message_id: null, in_reply_to: null, thread_references: null, provider_message_id: null, account_id: 'a1' }] };
    }
    return { rows: sql.includes('FROM email_accounts') ? [account] : [{ preferences: {}, id: 'book1' }] };
  });
  redisClient.get.mockResolvedValue(null);
  redisClient.set.mockResolvedValue('OK');
  redisClient.del.mockResolvedValue(1);
  redisClient.eval.mockResolvedValue(1);
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail, verify: vi.fn() } });
  sendMail.mockResolvedValue({});
  resolveSentFolder.mockResolvedValue(null);
});
const defaultBody = { accountId: 'a1', to: ['you@example.com'], subject: 'Test', body: 'Hello' };
const post = (body: Record<string, unknown> = defaultBody, idempotencyKey = 'send1') => fetch(`${base}/api/mail/send`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': idempotencyKey },
  body: JSON.stringify(body),
});

function mockExistingIntent(status: 'pending' | 'uncertain' | 'completed', result: unknown = null, fingerprint = 'same') {
  let incomingFingerprint = '';
  query.mockImplementation(async (sql, params: unknown[] = []) => {
    // Resolving the answered message: the composer sends its row id and the server reads the RFC Message-ID.
    if (sql.includes('FROM messages m JOIN email_accounts')) {
      return { rows: [{ id: 'parent-row', message_id: '<parent@example.com>', canonical_message_id: null, in_reply_to: null, thread_references: null, provider_message_id: null, account_id: 'a1' }] };
    }
    if (sql.includes('FROM email_accounts')) return { rows: [account] };
    if (sql.includes('SELECT preferences FROM users')) return { rows: [{ preferences: {} }] };
    // A prior successful send may still be auto-learning contacts when the next
    // duplicate-intent test replaces this mock. Keep that detached work harmless.
    if (sql.includes('INSERT INTO address_books')) return { rows: [{ id: 'book1' }] };
    if (sql.includes('INSERT INTO contacts')) return { rows: [{ address_book_id: 'book1' }] };
    if (sql.includes('UPDATE address_books')) return { rows: [] };
    if (sql.includes('INSERT INTO send_idempotency')) {
      incomingFingerprint = String(params[2]);
      return { rows: [] }; // conflict: this is a duplicate key
    }
    if (sql.includes('SELECT status, request_fingerprint, result')) {
      return { rows: [{ status, request_fingerprint: fingerprint === 'same' ? incomingFingerprint : fingerprint, result }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
}

describe('send failure semantics', () => {
  it('does not deliver when idempotency lookup fails', async () => {
    redisClient.get.mockRejectedValueOnce(new Error('Redis unavailable'));
    expect((await post()).status).toBe(503);
    expect(sendMail).not.toHaveBeenCalled();
  });
  it('does not deliver or remove another lock when reservation fails', async () => {
    redisClient.set.mockRejectedValueOnce(new Error('Redis unavailable'));
    expect((await post()).status).toBe(503);
    expect(sendMail).not.toHaveBeenCalled();
    expect(redisClient.del).not.toHaveBeenCalled();
  });
  it('does not clear a concurrent send lock after a pre-reservation failure', async () => {
    createAccountSmtpTransport.mockRejectedValueOnce(new Error('SMTP setup failed'));
    expect((await post()).status).toBe(500);
    expect(redisClient.del).not.toHaveBeenCalled();
  });
  it('reports SMTP recipient rejection as a partial, non-retryable result', async () => {
    sendMail.mockResolvedValueOnce({ accepted: ['you@example.com'], rejected: ['missing@example.com'] });
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()) as JsonBody).toEqual({
      ok: true, partialDelivery: true, accepted: ['you@example.com'], rejected: ['missing@example.com'],
    });
    expect(redisClient.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('SET'"), expect.objectContaining({
      keys: ['send_idem:u1:send1'],
    }));
  });

  it('retains partial recipient details after a post-delivery failure', async () => {
    sendMail.mockResolvedValueOnce({ accepted: ['you@example.com'], rejected: ['missing@example.com'] });
    resolveSentFolder.mockRejectedValueOnce(new Error('database unavailable'));
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()) as JsonBody).toEqual({
      ok: true, sentCopySaved: false, partialDelivery: true,
      accepted: ['you@example.com'], rejected: ['missing@example.com'],
    });
    expect(sendMail).toHaveBeenCalledOnce();
    expect(redisClient.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('SET'"), expect.objectContaining({
      keys: ['send_idem:u1:send1'],
    }));
    expect(redisClient.del).not.toHaveBeenCalled();
  });
  it('releases its own reservation after an SMTP rejection', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('550 rejected'), { responseCode: 550 }));
    expect((await post()).status).toBe(500);
    expect(redisClient.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('DEL'"), expect.objectContaining({
      keys: ['send_idem:u1:send1'],
    }));
  });

  it.each([
    [421, 'CONN'],
    [450, 'RCPT TO'],
    [451, 'DATA'],
    [452, 'MAIL FROM'],
    [454, 'STARTTLS'],
    [550, 'DATA'],
  ])('releases the idempotency key after explicit SMTP %i at %s so it can retry', async (responseCode, command) => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error(String(responseCode) + ' rejected'), { responseCode, command }));

    expect((await post()).status).toBe(500);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM send_idempotency'), expect.any(Array));
    expect(redisClient.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('DEL'"), expect.objectContaining({
      keys: ['send_idem:u1:send1'],
    }));

    const retry = await post();
    expect(retry.status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it.each(['ECONNECTION', 'ETIMEDOUT'])('keeps the durable intent after ambiguous %s loss following DATA', async (code) => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('connection lost after DATA: ' + code), { code, command: 'DATA' }));
    const response = await post();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'The mail server response was interrupted after dispatch began. This message will not be sent again automatically.' });
    expect(redisClient.eval).not.toHaveBeenCalledWith(expect.stringContaining("redis.call('DEL'"), expect.anything());
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status = 'uncertain'"), expect.any(Array));
  });

  it('does not treat a 5xx-looking error message as a known SMTP rejection', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('550 transcript fragment after DATA'), { command: 'DATA' }));
    const response = await post();
    expect(response.status).toBe(502);
    expect(redisClient.eval).not.toHaveBeenCalledWith(expect.stringContaining("redis.call('DEL'"), expect.anything());
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status = 'uncertain'"), expect.any(Array));
  });
  it('blocks a concurrent submission', async () => {
    redisClient.set.mockResolvedValueOnce(null);
    expect((await post()).status).toBe(409);
    expect(sendMail).not.toHaveBeenCalled();
    expect(redisClient.del).not.toHaveBeenCalled();
  });

  // Blind recipients are a privacy boundary, not a formatting detail: the address must
  // reach the transport's envelope and must never appear in a visible field. This case is
  // written against what the route controls today (the options it hands over) so that it
  // still holds when the message is composed once and passed as `raw` — at which point the
  // envelope becomes explicit and this assertion can be extended to it. The suite's other
  // BCC case asserts only that `bcc` was passed, which a `raw` send would keep true while
  // dropping the recipient entirely.
  it('never places a blind recipient in a visible field', async () => {
    const response = await post({
      accountId: 'a1',
      to: ['visible@example.com'],
      cc: ['copy@example.com'],
      bcc: ['blind@example.com'],
      subject: 'Private',
      body: 'Hello',
    });

    expect(response.status).toBe(200);
    const [mailOptions] = sendMail.mock.calls[0];
    // Carried where it belongs — the envelope nodemailer builds from `bcc`.
    expect(mailOptions).toMatchObject({ bcc: 'blind@example.com' });
    // And nowhere a recipient or a relay could read it from the headers.
    expect(String(mailOptions.to ?? '')).not.toContain('blind@');
    expect(String(mailOptions.cc ?? '')).not.toContain('blind@');
    expect(mailOptions).not.toHaveProperty('headers');
    // The envelope is where the blind recipient does belong, and it is now stated rather
    // than left for nodemailer to derive — so the guarantee survives the message being
    // composed once and sent as `raw`, where headers could not carry it.
    expect(mailOptions.envelope).toEqual({
      from: 'me@example.com',
      to: ['visible@example.com', 'copy@example.com', 'blind@example.com'],
    });
  });

  it('accepts BCC-only delivery without adding a visible To header', async () => {
    const response = await post({
      accountId: 'a1', bcc: ['blind@example.com'], subject: 'Private', body: 'Hello',
    });

    expect(response.status).toBe(200);
    expect(sendMail).toHaveBeenCalledOnce();
    const [mailOptions] = sendMail.mock.calls[0];
    expect(mailOptions).toMatchObject({ bcc: 'blind@example.com' });
    expect(mailOptions).not.toHaveProperty('to');
  });

  it('renders an SMTP reply with the authoritative RFC chain (THR-08)', async () => {
    const response = await post({
      ...defaultBody,
      replyToMessageId: '11111111-1111-4111-8111-111111111111',
      sendKind: 'reply',
      // Deliberately false client hints: the parent row must win.
      inReplyTo: '<forged@example.test>', references: '<forged@example.test>',
    });

    expect(response.status).toBe(200);
    const [mailOptions] = sendMail.mock.calls[0];
    const raw = Buffer.isBuffer(mailOptions.raw) ? mailOptions.raw.toString('utf8') : String(mailOptions.raw);
    // Consume the raw wire payload through the same header parser used by
    // ingest, rather than asserting only a composer object.
    const parsed = parseRawHeaders(raw);
    expect(parsed['message-id']).toMatch(/^<[^>]+>$/);
    expect(parsed['in-reply-to']).toBe('<parent@example.com>');
    expect(parsed.references).toBe('<parent@example.com>');
    expect(raw).not.toContain('<forged@example.test>');
  });

  it('renders a complete de-duplicated multi-hop References chain (THR-06)', async () => {
    query.mockImplementation(async sql => {
      if (sql.includes('FROM messages m JOIN email_accounts')) return { rows: [{
        id: 'parent-row', message_id: '<c@example.test>', canonical_message_id: null,
        in_reply_to: '<b@example.test>', thread_references: '<a@example.test> <b@example.test> <a@example.test>',
        provider_message_id: null, account_id: 'a1',
      }] };
      return { rows: sql.includes('FROM email_accounts') ? [account] : [{ preferences: {}, id: 'book1' }] };
    });
    const response = await post({ ...defaultBody, replyToMessageId: '11111111-1111-4111-8111-111111111111', sendKind: 'reply' }, 'multihop');
    expect(response.status).toBe(200);
    const [mailOptions] = sendMail.mock.calls[0];
    const parsed = parseRawHeaders(Buffer.isBuffer(mailOptions.raw) ? mailOptions.raw : String(mailOptions.raw));
    expect(parsed['in-reply-to']).toBe('<c@example.test>');
    expect(parsed.references).toBe('<a@example.test> <b@example.test> <c@example.test>');
  });

  it.each([
    ['pending', null, 409, { error: 'This message is already being sent.' }],
    ['uncertain', null, 409, { code: 'SEND_OUTCOME_UNKNOWN', error: 'The result of this send is still being confirmed. It will not be sent again automatically.' }],
    ['completed', { ok: true, sentFolder: 'Sent' }, 200, { ok: true, sentFolder: 'Sent' }],
  ] as const)('returns durable duplicate intent %s without a second SMTP dispatch', async (status, result, expectedStatus, expectedBody) => {
    mockExistingIntent(status, result);

    const response = await post();
    expect(response.status).toBe(expectedStatus);
    expect(await response.json()).toEqual(expectedBody);
    expect(sendMail).not.toHaveBeenCalled();
    expect(redisClient.set).not.toHaveBeenCalled();
  });

  it('rejects a changed body from a warm fingerprinted Redis result', async () => {
    redisClient.get.mockResolvedValueOnce(JSON.stringify({
      version: 1, fingerprint: 'fingerprint-for-original-message', result: { ok: true },
    }));
    const response = await post({ ...defaultBody, body: 'Changed message' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'This idempotency key belongs to a different message.' });
    expect(sendMail).not.toHaveBeenCalled();
    expect(redisClient.set).not.toHaveBeenCalled();
  });

  it('rejects a duplicate key when its durable fingerprint belongs to another message', async () => {
    mockExistingIntent('pending', null, 'different-request-fingerprint');

    const response = await post({ ...defaultBody, subject: 'Changed message' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'This idempotency key belongs to a different message.' });
    expect(sendMail).not.toHaveBeenCalled();
    expect(redisClient.set).not.toHaveBeenCalled();
  });

  it('rejects the same key used for a reply to a different message', async () => {
    // MAIL-05: the fingerprint did not cover `replyToMessageId`, so two logically different replies with the
    // same text shared it and the second replayed the first delivery instead of sending (or conflicting).
    const fingerprints: string[] = [];
    query.mockImplementation(async (sql, params: unknown[] = []) => {
      if (sql.includes('FROM email_accounts')) return { rows: [account] };
      if (sql.includes('SELECT preferences FROM users')) return { rows: [{ preferences: {} }] };
      if (sql.includes('FROM messages m JOIN email_accounts')) {
        return { rows: [{ id: 'parent-row', message_id: '<parent@example.com>', canonical_message_id: null, in_reply_to: null, thread_references: null, provider_message_id: null, account_id: 'a1' }] };
      }
      if (sql.includes('INSERT INTO send_idempotency')) {
        fingerprints.push(String(params[2]));
        return { rows: [] }; // the key is already known
      }
      if (sql.includes('SELECT status, request_fingerprint, result')) {
        // The stored intent always belongs to the *first* request, so the second must not match it.
        return { rows: [{ status: 'completed', request_fingerprint: fingerprints[0], result: { ok: true } }] };
      }
      if (sql.includes('INSERT INTO address_books')) return { rows: [{ id: 'book1' }] };
      if (sql.includes('INSERT INTO contacts')) return { rows: [{ address_book_id: 'book1' }] };
      if (sql.includes('UPDATE address_books')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const first = await post({ ...defaultBody, replyToMessageId: '11111111-1111-4111-8111-111111111111' });
    expect(await first.json()).toEqual({ ok: true });
    const second = await post({ ...defaultBody, replyToMessageId: '22222222-2222-4222-8222-222222222222' });

    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'This idempotency key belongs to a different message.' });
    expect(fingerprints).toHaveLength(2);
    expect(fingerprints[1]).not.toBe(fingerprints[0]);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('rejects a malformed physical reply parent before transport dispatch', async () => {
    const response = await post({ ...defaultBody, sendKind: 'reply', replyToMessageId: 'not-a-message-uuid' });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: 'REPLY_PARENT_NOT_RESOLVABLE' });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('still replays a resend of the very same reply', async () => {
    // The other side of the same change: an identical reply under the same key must keep replaying.
    mockExistingIntent('completed', { ok: true });
    const response = await post({ ...defaultBody, replyToMessageId: '11111111-1111-4111-8111-111111111111' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('refuses a message above the installation limit before dispatch', async () => {
    // §12.2: the interface estimate is preliminary; the composed message is counted on the server, and nothing
    // may have been dispatched when it is too large.
    process.env.MAIL_MAX_MESSAGE_BYTES = '1000';
    try {
      const response = await fetch(`${base}/api/mail/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accountId: 'a1',
          to: ['you@example.com'],
          subject: 'Oversized',
          body: 'x'.repeat(4000),
        }),
      });
      expect(response.status).toBe(413);
      const body = await response.json() as { code?: string; error?: string };
      expect(body.code).toBe('MESSAGE_TOO_LARGE');
      expect(body.error).toContain('1000');
      // The whole point of counting it here: the message never reached SMTP.
      expect(sendMail).not.toHaveBeenCalled();
    } finally {
      delete process.env.MAIL_MAX_MESSAGE_BYTES;
    }
  });

  it('names an oversized attachment rather than only the total', async () => {
    // §22.1: an oversized attachment is reported as such. The bytes are the decoded ones, so this is a
    // measurement rather than trust in a declared size.
    process.env.MAIL_MAX_MESSAGE_BYTES = '1000';
    try {
      const response = await fetch(`${base}/api/mail/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accountId: 'a1',
          to: ['you@example.com'],
          subject: 'Big file',
          body: 'Hello',
          attachments: [{ filename: 'report.bin', content: Buffer.alloc(3000, 7).toString('base64') }],
        }),
      });
      expect(response.status).toBe(413);
      const body = await response.json() as { code?: string; error?: string };
      expect(body.code).toBe('ATTACHMENT_TOO_LARGE');
      expect(body.error).toContain('report.bin');
      expect(sendMail).not.toHaveBeenCalled();
    } finally {
      delete process.env.MAIL_MAX_MESSAGE_BYTES;
    }
  });

  it('says how much of an oversized message is attachments', async () => {
    // §12.2's figures, reported where a user can act on them: the attachment subtotal is measured from decoded
    // contents, and a file under the per-attachment limit still counts towards a message over it.
    process.env.MAIL_MAX_MESSAGE_BYTES = '1000';
    try {
      const response = await fetch(`${base}/api/mail/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accountId: 'a1',
          to: ['you@example.com'],
          subject: 'Mostly a file',
          body: 'x'.repeat(4000),
          attachments: [{ filename: 'small.bin', content: Buffer.alloc(700, 3).toString('base64') }],
        }),
      });
      expect(response.status).toBe(413);
      const body = await response.json() as { code?: string; error?: string };
      expect(body.code).toBe('MESSAGE_TOO_LARGE');
      expect(body.error).toContain('Attachments account for 700');
      expect(sendMail).not.toHaveBeenCalled();
    } finally {
      delete process.env.MAIL_MAX_MESSAGE_BYTES;
    }
  });
});
