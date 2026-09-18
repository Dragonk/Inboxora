import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    moveMessage: vi.fn<(...args: never[]) => Promise<number | null>>(),
    broadcast: vi.fn(),
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
  },
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query as __mock_query } from '../services/db.js';
import { imapManager as __mock_imapManager } from '../index.js';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const query = vi.mocked(__mock_query);
const imapManager = vi.mocked(__mock_imapManager);

const MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MESSAGE_ROW = {
  id: MESSAGE_ID,
  account_id: ACCOUNT_ID,
  folder: 'INBOX',
  uid: 42,
  message_id: '<m1@example.test>',
  subject: 'Free prize winner',
  body_text: 'Click here, buy now, claim your prize',
  body_html: null,
  from_email: 'promo@shady.example',
  reply_to: null,
  attachments: [{ filename: 'invoice.pdf' }],
  is_read: false,
  user_id: 'user-1',
  folder_mappings: { spam: 'Spam' },
};
const ACCOUNT_ROW = { id: ACCOUNT_ID, folder_mappings: { spam: 'Spam' } };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  return app;
}
const tick = () => new Promise(r => setTimeout(r, 20));

describe('POST /api/mail/messages/:id/spam — atomic training write', () => {
  let server: Server, base: string;
  beforeAll(async () => { await new Promise(r => { server = buildApp().listen(0, r); }); base = `http://127.0.0.1:${listeningPort(server)}`; });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset();
    imapManager.moveMessage.mockReset();
    imapManager.broadcast.mockReset();
    imapManager._guardMoveUid.mockReset();
    imapManager._unguardMoveUid.mockReset();
    imapManager.moveMessage.mockResolvedValue(4242 as never);
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT m.account_id, a.folder_mappings FROM messages m')) {
        return { rows: [{ account_id: ACCOUNT_ID, folder_mappings: { spam: 'Spam' } }] };
      }
      if (sql.includes('SELECT m.*, a.user_id, a.folder_mappings FROM messages m')) return { rows: [MESSAGE_ROW] };
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [ACCOUNT_ROW] };
      if (sql.includes('SELECT 1 FROM folders')) return { rows: [{}] };
      return { rows: [] };
    });
  });

  it('writes ONE atomic training INSERT with mark-time features (no UPDATE...ORDER BY...LIMIT)', async () => {
    const res = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/spam`, { method: 'POST' });
    expect(res.status).toBe(200);
    await tick();

    const inserts = query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO spam_training_log'));
    expect(inserts).toHaveLength(1);
    const [sql, params] = inserts[0] as [string, unknown[]];
    // Atomic: features travel in the same INSERT, not a later UPDATE.
    for (const col of ['token_counts', 'flag_features', 'sender_domain', 'attachment_types', 'subject', 'body_text']) {
      expect(sql).toContain(col);
    }
    // No PostgreSQL-invalid UPDATE...ORDER BY...LIMIT anywhere on this path.
    const badUpdates = query.mock.calls.filter(([s]) =>
      String(s).includes('UPDATE spam_training_log') && /ORDER BY/i.test(String(s)));
    expect(badUpdates).toHaveLength(0);
    // token_counts actually carries the message content.
    const tokenCounts = JSON.parse(String((params as unknown[])[9]));
    expect(Object.keys(tokenCounts).length).toBeGreaterThan(0);
    expect(tokenCounts).toHaveProperty('prize');
  });

  it('trains on the already-in-folder no-op path too', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT m.account_id, a.folder_mappings FROM messages m')) {
        return { rows: [{ account_id: ACCOUNT_ID, folder_mappings: { spam: 'Spam' } }] };
      }
      if (sql.includes('SELECT m.*, a.user_id, a.folder_mappings FROM messages m')) {
        return { rows: [{ ...MESSAGE_ROW, folder: 'Spam' }] };
      }
      if (sql.includes('SELECT 1 FROM folders')) return { rows: [{}] };
      return { rows: [] };
    });
    const res = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/spam`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ alreadyInFolder: true });
    await tick();
    const inserts = query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO spam_training_log'));
    expect(inserts).toHaveLength(1);
    expect(String(inserts[0]?.[0])).toContain('token_counts');
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
  });
});
