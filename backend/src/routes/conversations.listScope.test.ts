import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listeningPort } from '../test/net.js';
import type { Server } from 'node:http';

vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => {
    req.session = { userId: req.headers['x-test-user'] || 'user-a' };
    next();
  },
}));

import express from 'express';
import conversationsRoutes from './conversations.js';
import { query } from '../services/db.js';

// Expose mocked module exports with their Vitest mock helpers.
const mockQuery = vi.mocked(query);

const ACCOUNT_A = '11111111-1111-4111-8111-111111111119';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222229';
const CONVERSATION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONVERSATION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface ConversationRow {
  conversation_id: string;
  account_id: string;
  logical_messages: unknown[];
}

function isConversationRow(value: unknown): value is ConversationRow {
  return typeof value === 'object'
    && value !== null
    && 'conversation_id' in value
    && typeof value.conversation_id === 'string'
    && 'account_id' in value
    && typeof value.account_id === 'string'
    && 'logical_messages' in value
    && Array.isArray(value.logical_messages);
}

function conversationRows(body: unknown): ConversationRow[] {
  if (typeof body !== 'object'
    || body === null
    || !('conversations' in body)
    || !Array.isArray(body.conversations)
    || !body.conversations.every(isConversationRow)) {
    throw new Error('Expected a conversation-list response');
  }
  return body.conversations;
}

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
  let server: Server;
  let base = '';

  beforeAll(async () => {
    await new Promise(resolve => { server = buildApp().listen(0, resolve); });
    base = `http://127.0.0.1:${listeningPort(server)}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => mockQuery.mockReset());

  it('uses INBOX only as an entry condition and returns all 5 logical children from 6 copies', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [goldenRow()] });

    const response = await fetch(`${base}/api/mail/conversations?accountId=${ACCOUNT_A}&folder=INBOX`, {
      headers: { 'x-test-user': 'user-a' },
    });
    expect(response.status).toBe(200);
    const conversations = conversationRows(await response.json());
    expect(conversations).toHaveLength(1);
    const conversation = conversations[0];
    if (conversation === undefined) {
      throw new Error('Expected one conversation');
    }
    expect(conversation).toMatchObject({
      conversation_id: CONVERSATION_A,
      account_id: ACCOUNT_A,
      logical_message_count: 5,
      copy_count: 6,
    });
    expect(conversation.logical_messages).toHaveLength(5);

    const firstCall = mockQuery.mock.calls[0];
    if (firstCall === undefined) {
      throw new Error('Expected a database query');
    }
    const [sql, params] = firstCall;
    if (params === undefined) {
      throw new Error('Expected query parameters');
    }
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
    mockQuery.mockResolvedValueOnce({ rows: [
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
    const rows = conversationRows(await response.json());
    expect(rows.map(row => [row.conversation_id, row.account_id])).toEqual([
      [CONVERSATION_A, ACCOUNT_A],
      [CONVERSATION_B, ACCOUNT_B],
    ]);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('m_entry.account_id = c.account_id');
    expect(sql).toContain('include_in_unified_inbox = true');
    expect(sql).toContain('ca.account_id = c.account_id');
  });
});
