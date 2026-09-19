// The flag endpoints are the first production write path on the shared provider
// mutation layer (P03), so the wiring is asserted here rather than inferred: the
// route must route the IMAP write through `runProviderMutation`, and it must
// translate the layer's shared statuses back into the reconciler's behaviour —
// confirmed resolves a queued op, anything else keeps one queued.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const { runProviderMutation } = vi.hoisted(() => ({ runProviderMutation: vi.fn() }));

vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    setFlag: vi.fn<(...args: never[]) => Promise<void>>(),
    broadcast: vi.fn(),
    _resolveFlagPush: vi.fn(),
    _enqueueFlagPush: vi.fn(),
    pluginFacade: {},
  },
}));
vi.mock('../services/providerMutationService.js', () => ({ runProviderMutation }));

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

function messageRow() {
  return {
    id: MESSAGE_ID,
    account_id: ACCOUNT_ID,
    folder: 'INBOX',
    uid: 42,
    message_id: null,
    is_read: false,
    is_starred: false,
    user_id: 'user-1',
    sibling_count: 1,
  };
}

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  runProviderMutation.mockReset();
  imapManager._resolveFlagPush.mockReset();
  imapManager._enqueueFlagPush.mockReset();
  imapManager.broadcast.mockReset();
  imapManager.setFlag.mockReset();
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});

function arrangeMessage(options: { message?: Record<string, unknown>; account?: Record<string, unknown> } = {}) {
  query
    .mockResolvedValueOnce({ rows: [{ ...messageRow(), ...options.message }], rowCount: 1 })   // message lookup
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })                                          // UPDATE messages
    .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, ...options.account }], rowCount: 1 });   // account lookup
}

function graphAccount() {
  return { mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' };
}

describe('a mail flag write goes through the provider mutation layer', () => {
  it('sends the read flag through the layer and resolves the queued op when confirmed', async () => {
    arrangeMessage();
    runProviderMutation.mockResolvedValue({ status: 'confirmed', operationId: 'op-1', replayed: false });

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/read`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ read: true }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, is_read: true });
    expect(runProviderMutation).toHaveBeenCalledTimes(1);
    const [request, adapter] = runProviderMutation.mock.calls[0];
    expect(request).toMatchObject({
      userId: 'user-1', channel: 'web', operation: 'update', accountId: ACCOUNT_ID, resourceId: MESSAGE_ID,
    });
    // No idempotency key: each click is a new intent, and the journal's replay is for
    // a retry of the same intent.
    expect(request.idempotencyKey).toBeUndefined();
    expect(adapter).toMatchObject({ resourceType: 'message', idempotent: true });
    expect(imapManager._resolveFlagPush).toHaveBeenCalledWith(ACCOUNT_ID, MESSAGE_ID, '\\Seen');
    expect(imapManager._enqueueFlagPush).not.toHaveBeenCalled();
  });

  it('keeps a queued op for the reconciler when the layer reports an unknown outcome', async () => {
    arrangeMessage();
    runProviderMutation.mockResolvedValue({ status: 'outcome_unknown', operationId: 'op-2', code: 'MUTATION_OUTCOME_UNKNOWN', replayed: false });

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/read`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ read: true }),
    });

    // The user's local change stands; only the provider confirmation is pending.
    expect(response.status).toBe(200);
    expect(imapManager._resolveFlagPush).not.toHaveBeenCalled();
    expect(imapManager._enqueueFlagPush).toHaveBeenCalledWith(ACCOUNT_ID, MESSAGE_ID, '\\Seen', true);
  });

  it('keeps a queued op when the journal itself is unavailable', async () => {
    arrangeMessage();
    runProviderMutation.mockRejectedValue(new Error('relation "provider_operations" does not exist'));

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/read`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ read: true }),
    });

    expect(response.status).toBe(200);
    expect(imapManager._enqueueFlagPush).toHaveBeenCalledWith(ACCOUNT_ID, MESSAGE_ID, '\\Seen', true);
  });

  it('routes the star flag through the same layer', async () => {
    arrangeMessage();
    runProviderMutation.mockResolvedValue({ status: 'confirmed', operationId: 'op-3', replayed: false });

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/star`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ starred: true }),
    });

    expect(response.status).toBe(200);
    expect(runProviderMutation).toHaveBeenCalledTimes(1);
    expect(imapManager._resolveFlagPush).toHaveBeenCalledWith(ACCOUNT_ID, MESSAGE_ID, '\\Flagged');
  });
});

describe('a Microsoft Graph account writes over Graph, not IMAP', () => {
  it('routes the flag through the Graph adapter and never queues an IMAP push', async () => {
    arrangeMessage({ message: { provider_message_id: 'AAMkAD-1' }, account: graphAccount() });
    runProviderMutation.mockResolvedValue({ status: 'confirmed', operationId: 'op-g', replayed: false });

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/read`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ read: true }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, is_read: true });
    const [request, adapter] = runProviderMutation.mock.calls[0];
    // The Graph intent is identified per action and per value, so a scheduled retry
    // can reclaim its own row while a later click is a new operation.
    expect(String(request.idempotencyKey)).toContain('graph-mail-flag:');
    expect(request.payload).toMatchObject({ providerMessageId: 'AAMkAD-1', flag: '\\Seen', value: true });
    expect(adapter).toMatchObject({ resourceType: 'message', idempotent: true });
    // The IMAP reconciler writes over IMAP, so it must not be involved at all.
    expect(imapManager._enqueueFlagPush).not.toHaveBeenCalled();
    expect(imapManager.setFlag).not.toHaveBeenCalled();
  });

  it('undoes the optimistic local change when the provider refuses it permanently', async () => {
    arrangeMessage({ message: { provider_message_id: 'AAMkAD-1' }, account: graphAccount() });
    runProviderMutation.mockResolvedValue({ status: 'permanent', operationId: 'op-g', code: 'RESOURCE_NOT_FOUND', replayed: false });

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/read`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ read: true }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    // The row goes back to what the mailbox actually holds, rather than keeping a
    // local state the provider does not have.
    const revert = query.mock.calls.find(([sql]) => String(sql).includes('read_changed_at = NULL'));
    expect(revert).toBeDefined();
    expect(imapManager.broadcast).not.toHaveBeenCalled();
    expect(imapManager._enqueueFlagPush).not.toHaveBeenCalled();
  });

  it('leaves the optimistic change in place for an unknown outcome, to be retried', async () => {
    arrangeMessage({ message: { provider_message_id: 'AAMkAD-1' }, account: graphAccount() });
    runProviderMutation.mockResolvedValue({ status: 'outcome_unknown', operationId: 'op-g', code: 'MUTATION_OUTCOME_UNKNOWN', replayed: false });

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/star`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ starred: true }),
    });

    expect(response.status).toBe(200);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('star_changed_at = NULL'))).toBe(false);
    expect(imapManager._enqueueFlagPush).not.toHaveBeenCalled();
  });
});
