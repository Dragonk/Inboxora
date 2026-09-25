// Real PostgreSQL, real durable send ledger, real provider-operation table — the provider itself is faked at
// the module boundary because the question here is about *state*, not about Microsoft.
//
// Run against a migrated scratch database:
//   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=<db> DB_USER=... DB_PASSWORD=... \
//   REQUIRE_SEND_POSTGRES=1 npx vitest run src/routes/send.limits.integration.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { randomUUID } from 'crypto';
import express from 'express';
import 'express-async-errors';
import { pool, query } from '../services/db.js';
import { listeningPort } from '../test/net.js';
import { mockSession } from '../test/http.js';

const draftMock = vi.hoisted(() => vi.fn(async () => ({ id: 'AAMkAD-draft-1' })));
const sendMock = vi.hoisted(() => vi.fn(async () => ({ status: 'accepted' as const })));
vi.mock('../services/providers/microsoft/graphMailSend.js', () => ({ createGraphDraft: draftMock, sendGraphDraft: sendMock }));
vi.mock('../services/providers/microsoft/graphMailAttachments.js', () => ({ addGraphAttachment: vi.fn(async () => ({ id: 'att-1', strategy: 'direct' as const })) }));
vi.mock('../index.js', () => ({ imapManager: { appendToSent: vi.fn(), syncFolderOnDemand: vi.fn(), upsertSentMessageRecord: vi.fn() } }));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn(async () => 'Sent') }));
// Redis is the idempotency *cache* in front of the durable ledger this suite is about, so it is replaced;
// the `send_idempotency` assertions below read real rows and are unaffected by the substitution.
vi.mock('../services/redis.js', () => ({
  redisClient: { get: vi.fn(async () => null), set: vi.fn(async () => 'OK'), del: vi.fn(async () => 1), eval: vi.fn(async () => 1) },
}));

import sendRouter from './send.js';

const enabled = process.env.REQUIRE_SEND_POSTGRES === '1';

describe.skipIf(!enabled)('a size refusal and the durable send ledger (PostgreSQL)', () => {
  const userId = randomUUID();
  const accountId = randomUUID();
  const connectionId = randomUUID();
  const mailbox = `limit-${accountId.slice(0, 8)}@contoso.test`;
  let server: Server;
  let base = '';

  beforeAll(async () => {
    await query('INSERT INTO users(id, username, password_hash) VALUES($1,$2,$3)', [userId, `limit-${userId}`, 'unused']);
    await query(
      `INSERT INTO provider_connections (id, user_id, provider, issuer, subject, provider_user_id)
       VALUES ($1, $2, 'microsoft', 'https://login.microsoftonline.com/common/v2.0', $3, $4)`,
      [connectionId, userId, `sub-${connectionId}`, mailbox],
    );
    await query(
      `INSERT INTO email_accounts
         (id, user_id, name, email_address, protocol, imap_host, oauth_provider, mail_transport, provider_connection_id)
       VALUES ($1, $2, 'Outlook', $3, 'imap', 'outlook.office365.com', 'microsoft', 'microsoft_graph', $4)`,
      [accountId, userId, mailbox, connectionId],
    );

    const app = express();
    app.use(express.json({ limit: '210mb' }));
    app.use('/api/mail', (req, _res, next) => { req.session = mockSession({ userId }); next(); });
    app.use('/api/mail', sendRouter);
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${listeningPort(server)}`;
  });

  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    await pool.end();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    draftMock.mockResolvedValue({ id: 'AAMkAD-draft-1' });
    sendMock.mockResolvedValue({ status: 'accepted' });
    delete process.env.MAIL_MAX_ATTACHMENT_BYTES;
  });

  const post = (idempotencyKey: string, body: Record<string, unknown>) => fetch(`${base}/api/mail/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ accountId, to: ['you@example.com'], subject: 'Limits', body: 'Hello', ...body }),
  });

  it('leaves no uncertain intent and no provider operation, and lets the same key retry smaller', async () => {
    const key = `p06-${randomUUID()}`;

    // 1. A size the installation refuses. Nothing may be claimed, and nothing may be left to reconcile.
    process.env.MAIL_MAX_ATTACHMENT_BYTES = '1000';
    const refused = await post(key, {
      attachments: [{ filename: 'too-big.bin', content: Buffer.alloc(2000, 7).toString('base64') }],
    });
    expect(refused.status).toBe(413);
    expect(await refused.json()).toMatchObject({ code: 'ATTACHMENT_TOO_LARGE', dimension: 'attachment' });

    const afterRefusal = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM send_idempotency WHERE user_id = $1', [userId],
    );
    expect(afterRefusal.rows[0]?.count).toBe('0');
    const operationsAfterRefusal = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM provider_operations WHERE user_id = $1', [userId],
    );
    expect(operationsAfterRefusal.rows[0]?.count).toBe('0');
    expect(draftMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();

    // 2. The same idempotency key with a message that fits: the refusal must not have poisoned it.
    delete process.env.MAIL_MAX_ATTACHMENT_BYTES;
    const accepted = await post(key, {
      attachments: [{ filename: 'small.bin', content: Buffer.alloc(500, 7).toString('base64') }],
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true, sentFolder: 'Sent' });

    const afterSend = await query<{ status: string; result: unknown }>(
      'SELECT status, result FROM send_idempotency WHERE user_id = $1 AND idempotency_key = $2', [userId, key],
    );
    expect(afterSend.rows).toHaveLength(1);
    expect(afterSend.rows[0]?.status).toBe('completed');
    expect(afterSend.rows[0]?.result).toMatchObject({ ok: true });
    // A completed send is not an uncertain one, and it created no provider operation to reconcile.
    const operationsAfterSend = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM provider_operations WHERE user_id = $1', [userId],
    );
    expect(operationsAfterSend.rows[0]?.count).toBe('0');
  });
});
