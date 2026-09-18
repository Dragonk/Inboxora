import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./spamModelStore.js', () => ({ getModelForUser: vi.fn() }));

import { query as __mock_query } from './db.js';
import { getModelForUser as __mock_getModel } from './spamModelStore.js';
import { classifyAndTagMessage, SPAM_THRESHOLD, AUTO_MOVE_THRESHOLD } from './spamPipeline.js';
import { createEmptyModel, updateIncremental } from './spamModel.js';

const query = vi.mocked(__mock_query);
const getModelForUser = vi.mocked(__mock_getModel);

const BASE_ROW = {
  id: 'msg-1',
  account_id: 'acct-1',
  folder: 'INBOX',
  uid: 42,
  subject: 'Free prize winner!!!',
  body_text: 'Click here, buy now, claim your million dollars today',
  body_html: null,
  from_email: 'promo@shady.example',
  reply_to: null,
  attachments: [],
  spam_user_override: null,
  owner_id: 'user-1',
  account_email: 'me@example.com',
  antispam_enabled: true,
  folder_mappings: { spam: 'Spam' },
  trusted_authserv_id: null,
  master_spam_enabled: null,
};

beforeEach(() => {
  query.mockReset();
  getModelForUser.mockReset();
});

function mockMessageRow(overrides: Record<string, unknown> = {}) {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM messages m')) return { rows: [{ ...BASE_ROW, ...overrides }] };
    if (sql.startsWith('UPDATE messages SET')) return { rows: [] };
    if (sql.startsWith('DELETE FROM messages')) return { rows: [] };
    return { rows: [] };
  });
}

describe('spam pipeline gates', () => {
  it('skips when the user already overrode the verdict', async () => {
    mockMessageRow({ spam_user_override: 'ham' });
    const summary = await classifyAndTagMessage('msg-1');
    expect(summary?.skipped).toBe('user_override');
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE messages SET'))).toBe(false);
  });

  it('skips when the account opted out', async () => {
    mockMessageRow({ antispam_enabled: false });
    const summary = await classifyAndTagMessage('msg-1');
    expect(summary?.skipped).toBe('antispam_disabled');
  });

  it('skips when the master switch is off', async () => {
    mockMessageRow({ master_spam_enabled: 'false' });
    const summary = await classifyAndTagMessage('msg-1');
    expect(summary?.skipped).toBe('spam_disabled');
  });

  it('tags rules-only spam without moving below the auto-move threshold', async () => {
    mockMessageRow();
    getModelForUser.mockResolvedValue(null);
    const imap = { moveMessage: vi.fn() };
    const summary = await classifyAndTagMessage('msg-1', { imap });
    expect(summary?.method).toBe('rules');
    expect(summary?.verdict).toBe('spam');
    expect(summary && summary.blendedScore >= SPAM_THRESHOLD).toBe(true);
    // Rules-only never auto-moves (no ML backing).
    expect(summary?.shouldMove).toBe(false);
    expect(imap.moveMessage).not.toHaveBeenCalled();
  });

  it('auto-moves a mature high-confidence spam', async () => {
    mockMessageRow();
    let model = createEmptyModel();
    for (let i = 0; i < 60; i++) {
      model = updateIncremental(model, ['viagra', 'prize', 'winner', 'claim'], null, 'spam');
      model = updateIncremental(model, ['meeting', 'agenda', 'minutes'], null, 'ham');
    }
    getModelForUser.mockResolvedValue(model);
    const imap = {
      moveMessage: vi.fn().mockResolvedValue(4242),
      broadcast: vi.fn(),
      _guardMoveUid: vi.fn(),
      _unguardMoveUid: vi.fn(),
    };
    const summary = await classifyAndTagMessage('msg-1', { imap });
    expect(summary?.method).toBe('blended');
    expect(summary?.verdict).toBe('spam');
    expect(summary && summary.blendedScore >= AUTO_MOVE_THRESHOLD).toBe(true);
    expect(summary?.shouldMove).toBe(true);
    expect(summary?.moved).toBe(true);
    expect(imap.moveMessage).toHaveBeenCalledTimes(1);
  });

  it('records but defers the move on the backfill path', async () => {
    mockMessageRow();
    let model = createEmptyModel();
    for (let i = 0; i < 60; i++) {
      model = updateIncremental(model, ['viagra', 'prize', 'winner', 'claim'], null, 'spam');
      model = updateIncremental(model, ['meeting', 'agenda', 'minutes'], null, 'ham');
    }
    getModelForUser.mockResolvedValue(model);
    const imap = { moveMessage: vi.fn() };
    const summary = await classifyAndTagMessage('msg-1', { imap, deferAutoMove: true });
    expect(summary?.shouldMove).toBe(false);
    expect(summary?.autoMoveDeferred).toBe(true);
    expect(summary?.verdict).toBe('spam');
    expect(imap.moveMessage).not.toHaveBeenCalled();
    const update = query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE messages SET'));
    expect(JSON.stringify(update?.[1] ?? '')).toContain('autoMoveDeferred');
  });

  it('survives a failed auto-move without throwing', async () => {
    mockMessageRow();
    let model = createEmptyModel();
    for (let i = 0; i < 60; i++) {
      model = updateIncremental(model, ['viagra', 'prize', 'winner', 'claim'], null, 'spam');
      model = updateIncremental(model, ['meeting', 'agenda', 'minutes'], null, 'ham');
    }
    getModelForUser.mockResolvedValue(model);
    const imap = {
      moveMessage: vi.fn().mockRejectedValue(new Error('IMAP down')),
      _guardMoveUid: vi.fn(),
      _unguardMoveUid: vi.fn(),
    };
    const summary = await classifyAndTagMessage('msg-1', { imap });
    expect(summary?.shouldMove).toBe(true);
    expect(summary?.moved).toBe(false);
  });
});
