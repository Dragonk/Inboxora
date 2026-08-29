import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

const ACCOUNT_A = '11111111-1111-4111-8111-111111111119';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222229';
const CONVERSATION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONVERSATION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function buildApp() {
  const app = express();
  app.use('/api/mail', conversationsRoutes);
  return app;
}

function goldenRow(overrides = {}) {
  return {
    conversation_id: CONVERSATION_A,
    account_id: ACCOUNT_A,
    canonical_subject: 'Golden thread',
    logical_message_count: 5,
    copy_count: 6,
    unread_count: 2,
    visible_copy_count: 6,
    latest_copy_id: '55555555-5555-4555-8555-555555555555',
    total_count: 1,
    sort_date: '2026-08-25T12:00:00.000Z',
    logical_messages: Array.from({ length: 5 }, (_, index) => ({
      id: `logical-${index + 1}`,
      latestCopyId: `copy-${index + 1}`,
    })),
    ...overrides,
  };
}

describe('GET /api/mail/conversations list contract', () => {
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

  it('uses INBOX only as an entry condition and returns all 5 logical children from 6 copies', async () => {
    query.mockResolvedValueOnce({ rows: [goldenRow()] });

    const response = await fetch(`${base}/api/mail/conversations?accountId=${ACCOUNT_A}&folder=INBOX`, {
      headers: { 'x-test-user': 'user-a' },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]).toMatchObject({
      conversation_id: CONVERSATION_A,
      account_id: ACCOUNT_A,
      logical_message_count: 5,
      copy_count: 6,
    });
    expect(body.conversations[0].logical_messages).toHaveLength(5);

    const [sql, params] = query.mock.calls[0];
    expect(params.slice(0, 3)).toEqual(['user-a', ACCOUNT_A, 'INBOX']);
    expect(sql).toContain('COUNT(DISTINCT m.logical_message_id)::int AS logical_message_count');
    expect(sql).toContain('COUNT(m.id)::int AS copy_count');
    expect(sql).toContain('EXISTS (SELECT 1 FROM messages m_entry');
    expect(sql).toContain('m_entry.folder = $3');
    expect(sql).toContain('JOIN messages m ON m.conversation_id = c.id AND m.account_id = c.account_id');
    expect(sql).toContain('WHERE lm.conversation_id = c.id AND lm.account_id = c.account_id');
    expect(sql).not.toContain('COUNT(DISTINCT m.message_id)');
  });

  it('keeps the same RFC exchange as two account-local unified rows', async () => {
    query.mockResolvedValueOnce({ rows: [
      goldenRow(),
      goldenRow({
        conversation_id: CONVERSATION_B,
        account_id: ACCOUNT_B,
        latest_copy_id: '66666666-6666-4666-8666-666666666666',
        total_count: 2,
        logical_messages: [{ id: 'logical-b', latestCopyId: 'copy-b' }],
        logical_message_count: 1,
        copy_count: 1,
      }),
    ] });

    const response = await fetch(`${base}/api/mail/conversations?folder=INBOX&unifiedInbox=1`, {
      headers: { 'x-test-user': 'user-a' },
    });
    expect(response.status).toBe(200);
    const rows = (await response.json()).conversations;
    expect(rows.map(row => [row.conversation_id, row.account_id])).toEqual([
      [CONVERSATION_A, ACCOUNT_A],
      [CONVERSATION_B, ACCOUNT_B],
    ]);
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('m_entry.account_id = c.account_id');
    expect(sql).toContain('include_in_unified_inbox = true');
    expect(sql).toContain('ca.account_id = c.account_id');
  });
});
