import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: req.headers['x-test-user'] || 'user-a' };
    next();
  },
}));

import express from 'express';
import conversationsRoutes from './conversations.js';
import { query } from '../services/db.js';

const COPY_ID = '11111111-1111-4111-8111-111111111111';
const MESSAGE_ID = '<a+b@example.test>';
const ACCOUNT_A = '11111111-1111-4111-8111-111111111119';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222229';

function candidate({
  id = COPY_ID,
  logicalMessageId = 'logical-a',
  conversationId = 'conversation-a',
  folder = 'INBOX',
  accountId = ACCOUNT_A,
  date = '2026-08-25T10:00:00.000Z',
} = {}) {
  return {
    id,
    logical_message_id: logicalMessageId,
    conversation_id: conversationId,
    folder,
    account_id: accountId,
    date,
  };
}

function buildApp() {
  const app = express();
  app.use('/api/mail', conversationsRoutes);
  return app;
}

describe('GET /api/mail/messages/:ref/conversation', () => {
  let server;
  let base;

  beforeAll(async () => {
    await new Promise(resolve => { server = buildApp().listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => query.mockReset());

  async function resolve(ref, userId = 'user-a', accountId = null) {
    const qs = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
    return fetch(`${base}/api/mail/messages/${encodeURIComponent(ref)}/conversation${qs}`, {
      headers: { 'x-test-user': userId },
    });
  }

  it('resolves a physical UUID to its exact tenant-owned physical copy identity', async () => {
    query.mockResolvedValueOnce({ rows: [candidate({ logicalMessageId: 'logical-physical', conversationId: 'conversation-physical' })] });

    const response = await resolve(COPY_ID);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ logical_message_id: 'logical-physical', conversation_id: 'conversation-physical' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('WHERE m.id = $1 AND a.user_id = $2 AND m.is_deleted = false');
    expect(sql).not.toContain('m.canonical_message_id = $1');
    expect(params).toEqual([COPY_ID, 'user-a']);
  });

  it('allows folder copies in one account when they all have one logical/conversation identity', async () => {
    query.mockResolvedValueOnce({ rows: [
      candidate({ id: 'all-mail', accountId: ACCOUNT_A, folder: 'All Mail', date: '2026-08-25T12:00:00.000Z' }),
      candidate({ id: 'sent-copy', accountId: ACCOUNT_A, folder: 'Sent', date: '2026-08-25T13:00:00.000Z' }),
      candidate({ id: 'inbox-copy', accountId: ACCOUNT_A, folder: 'INBOX', date: '2026-08-25T11:00:00.000Z' }),
    ] });

    const response = await resolve(MESSAGE_ID, 'user-a', ACCOUNT_A);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ logical_message_id: 'logical-a', conversation_id: 'conversation-a' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('m.canonical_message_id = $1');
    expect(sql).toContain('a.user_id = $2');
    expect(sql).toContain('($3::uuid IS NULL OR m.account_id = $3)');
    expect(sql).toContain('m.is_deleted = false');
    expect(sql).not.toContain('LIMIT 1');
    expect(params).toEqual([MESSAGE_ID, 'user-a', ACCOUNT_A]);
  });


  it('resolves an unscoped Message-ID when all live candidates have one account-local identity', async () => {
    query.mockResolvedValueOnce({ rows: [
      candidate({ id: 'all-mail', folder: 'All Mail' }),
      candidate({ id: 'inbox-copy', folder: 'INBOX' }),
    ] });

    const response = await resolve(MESSAGE_ID);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ account_id: ACCOUNT_A, conversation_id: 'conversation-a' });
    expect(query.mock.calls[0][1]).toEqual([MESSAGE_ID, 'user-a', null]);
  });

  it('returns 409 when an unscoped Message-ID exists in two managed accounts even if legacy IDs match', async () => {
    query.mockResolvedValueOnce({ rows: [
      candidate({ id: 'account-a-copy', accountId: ACCOUNT_A }),
      candidate({ id: 'account-b-copy', accountId: ACCOUNT_B }),
    ] });

    const response = await resolve(MESSAGE_ID);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Conversation reference is ambiguous', code: 'CONVERSATION_REFERENCE_AMBIGUOUS' });
    expect(query.mock.calls[0][1]).toEqual([MESSAGE_ID, 'user-a', null]);
  });

  it('rejects a malformed supplied accountId before querying', async () => {
    const response = await resolve(MESSAGE_ID, 'user-a', 'not-a-uuid');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid accountId' });
    expect(query).not.toHaveBeenCalled();
  });

  it('resolves the same Message-ID to account A after SQL filters out account B before ambiguity evaluation', async () => {
    query.mockImplementationOnce(async (_sql, [, , accountId]) => ({
      rows: accountId === ACCOUNT_A
        ? [candidate({ id: 'account-a-copy', accountId, logicalMessageId: 'logical-a', conversationId: 'conversation-a' })]
        : [],
    }));

    const response = await resolve(MESSAGE_ID, 'user-a', ACCOUNT_A);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ account_id: ACCOUNT_A, conversation_id: 'conversation-a' });
  });

  it('resolves the same Message-ID to account B independently of account A', async () => {
    query.mockImplementationOnce(async (_sql, [, , accountId]) => ({
      rows: accountId === ACCOUNT_B
        ? [candidate({ id: 'account-b-copy', accountId, logicalMessageId: 'logical-b', conversationId: 'conversation-b' })]
        : [],
    }));

    const response = await resolve(MESSAGE_ID, 'user-a', ACCOUNT_B);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ account_id: ACCOUNT_B, conversation_id: 'conversation-b' });
  });

  it('returns 409 for two live identities with the same Message-ID inside the requested account', async () => {
    query.mockResolvedValueOnce({ rows: [
      candidate({ id: 'inbox-newest', accountId: ACCOUNT_A, logicalMessageId: 'logical-a', conversationId: 'conversation-a', folder: 'INBOX', date: '2026-08-25T20:00:00.000Z' }),
      candidate({ id: 'older-other', accountId: ACCOUNT_A, logicalMessageId: 'logical-b', conversationId: 'conversation-b', folder: 'Archive', date: '2026-08-20T10:00:00.000Z' }),
    ] });

    const response = await resolve(MESSAGE_ID, 'user-a', ACCOUNT_A);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Conversation reference is ambiguous', code: 'CONVERSATION_REFERENCE_AMBIGUOUS' });
  });

  it('passes the session tenant to the Message-ID query, so another user cannot qualify a collision', async () => {
    query.mockImplementationOnce(async (_sql, [, userId]) => ({
      rows: userId === 'user-a'
        ? [candidate({ logicalMessageId: 'logical-a', conversationId: 'conversation-a' })]
        : [candidate({ logicalMessageId: 'logical-b', conversationId: 'conversation-b' })],
    }));

    const accountId = ACCOUNT_A;
    const response = await resolve(MESSAGE_ID, 'user-a', accountId);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ conversation_id: 'conversation-a' });
    expect(query.mock.calls[0][1]).toEqual([MESSAGE_ID, 'user-a', accountId]);
  });

  it('ignores a deleted conflicting copy in the database candidate query', async () => {
    query.mockResolvedValueOnce({ rows: [candidate({ logicalMessageId: 'logical-a', conversationId: 'conversation-a' })] });

    const response = await resolve(MESSAGE_ID, 'user-a', ACCOUNT_A);

    expect(response.status).toBe(200);
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('m.is_deleted = false');
  });

  it('accepts an encoded Message-ID containing <, >, @, and + via the canonical CE normalization', async () => {
    query.mockResolvedValueOnce({ rows: [candidate()] });

    const response = await resolve(MESSAGE_ID, 'user-a', ACCOUNT_A);

    expect(response.status).toBe(200);
    expect(query.mock.calls[0][1][0]).toBe(MESSAGE_ID);
  });

  it('returns 404 when no tenant-scoped live candidate exists', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const response = await resolve(MESSAGE_ID, 'user-a', ACCOUNT_A);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Conversation not found' });
  });

  it('bounds absurd refs and rejects invalid RFC Message-ID values before querying', async () => {
    const tooLong = `<${'a'.repeat(999)}@example.test>`;
    const longResponse = await resolve(tooLong);
    const malformedResponse = await resolve('<bad id@example.test>');

    expect(longResponse.status).toBe(400);
    expect(malformedResponse.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GET /api/mail/conversations/:id detail scope', () => {
  it('loads every logical message in the user-owned conversation without selected-account filtering', async () => {
    const canonical = '22222222-2222-4222-8222-222222222222';
    const client = { query: vi.fn(), release: vi.fn() };
    const { pool } = await import('../services/db.js');
    const originalConnect = pool.connect;
    pool.connect = vi.fn().mockResolvedValue(client);
    client.query
      .mockResolvedValueOnce({ rows: [{ account_id: 'account-a' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: canonical, user_id: 'user-a', logical_id: 'logical-a', canonical_message_id: '<m1@test>', subject: 'Cross', direction: 'incoming', message_date: '2026-08-25T10:00:00Z', threading_reason: 'new-root', threading_confidence: 1, copies: [{ id: COPY_ID, accountId: 'account-a' }] }] });

    let detailServer;
    await new Promise(resolve => { detailServer = buildApp().listen(0, resolve); });
    const response = await fetch(`http://127.0.0.1:${detailServer.address().port}/api/mail/conversations/${canonical}`, { headers: { 'x-test-user': 'user-a' } });
    expect(response.status).toBe(200);
    const [sql, params] = client.query.mock.calls[2];
    expect(sql).toContain('WHERE c.id = $1 AND c.user_id = $2');
    expect(sql).toContain('m.account_id = c.account_id');
    expect(sql).toContain('lm.account_id = c.account_id');
    expect(sql).toContain('c.account_id = $3');
    expect(sql).toContain("'listUnsubscribe', m.list_unsubscribe");
    expect(sql).toContain("'unsubscribedAt', m.unsubscribed_at");
    expect(params).toEqual([canonical, 'user-a', 'account-a']);
    await new Promise(resolve => detailServer.close(resolve));
    pool.connect = originalConnect;
  });
});
