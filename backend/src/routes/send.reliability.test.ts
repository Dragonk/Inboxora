import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { JsonBody } from '../test/json.js';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
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
  query.mockImplementation(async sql => ({ rows: sql.includes('FROM email_accounts') ? [account] : [{ preferences: {}, id: 'book1' }] }));
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

  it.each([
    ['pending', null, 409, { error: 'This message is already being sent.' }],
    ['uncertain', null, 409, { error: 'The result of this send is still being confirmed. It will not be sent again automatically.' }],
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

  it('refuses a message above the installation limit before dispatch', async () => {
    // §12.2: the interface estimate is preliminary; the composed message is counted on the server, and nothing
    // may have been dispatched when it is too large.
    process.env.MAIL_MAX_MESSAGE_BYTES = '1000';
    try {
      const response = await fetch(`${base}/api/mail/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          to: 'you@example.com',
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
});
