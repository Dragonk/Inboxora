// NA-14: the route must keep native rows when an IMAP UID relocation shares the bulk request.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import type { PoolClient } from 'pg';
import type { Server } from 'node:http';

const mocks = vi.hoisted(() => ({
  bulkMoveMessages: vi.fn(), guard: vi.fn(), unguard: vi.fn(), broadcast: vi.fn(),
  runProviderMutation: vi.fn(), moveGmailMessageToLabel: vi.fn(),
}));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req: { session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: USER_ID }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: { bulkMoveMessages: mocks.bulkMoveMessages, _guardMoveUid: mocks.guard, _unguardMoveUid: mocks.unguard, broadcast: mocks.broadcast, syncFolderOnDemand: vi.fn(), setFlag: vi.fn(), _resolveFlagPush: vi.fn(), _enqueueFlagPush: vi.fn(), markAllReadImap: vi.fn(), pluginFacade: {} } }));
vi.mock('../services/providerMutationService.js', () => ({ runProviderMutation: mocks.runProviderMutation }));
vi.mock('../services/providers/google/gmailMailMove.js', () => ({ moveGmailMessageToLabel: mocks.moveGmailMessageToLabel, archiveGmailMessage: vi.fn() }));
vi.mock('../services/providers/microsoft/graphMailSync.js', async importOriginal => ({ ...(await importOriginal<typeof import('../services/providers/microsoft/graphMailSync.js')>()), graphFolderIdForPath: vi.fn(async () => 'graph-trash') }));
vi.mock('../utils/mailUtils.js', async importOriginal => ({ ...(await importOriginal<typeof import('../utils/mailUtils.js')>()), resolveTrashFolder: vi.fn(async () => 'Trash'), resolveAllTrashPaths: vi.fn(async () => new Set(['Trash'])), resolveAllDraftsPaths: vi.fn(async () => new Set<string>()), adjustFolderCounts: vi.fn(), isAllMailFolder: vi.fn(async () => false) }));
vi.mock('../services/providerAuthService.js', async importOriginal => ({ ...(await importOriginal<typeof import('../services/providerAuthService.js')>()), googleConfigFromEnv: () => ({ clientId: 'c', clientSecret: 's', redirectUri: 'https://inboxora.test/cb' }), microsoftConfigFromEnv: () => ({ clientId: 'c', clientSecret: 's', redirectUri: 'https://inboxora.test/cb', tenantId: 'common' }) }));

import { pool } from '../services/db.js';
import mailRoutes from './mail.js';
import { listeningPort } from '../test/net.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;
const USER_ID = '00000000-0000-0000-0000-00000000d141';
const IMAP_ACCOUNT = '00000000-0000-0000-0000-00000000d142';
const GMAIL_ACCOUNT = '00000000-0000-0000-0000-00000000d143';
const GRAPH_ACCOUNT = '00000000-0000-0000-0000-00000000d144';
const IMAP_ID = '00000000-0000-0000-0000-00000000d145';
const GMAIL_ID = '00000000-0000-0000-0000-00000000d146';
const GRAPH_ID = '00000000-0000-0000-0000-00000000d147';

async function db<T>(fn: (client: PoolClient) => Promise<T>) { const c = await pool.connect(); try { return await fn(c); } finally { c.release(); } }
let server: Server; let base = '';
describeOrSkip('NA-14 mixed transport bulk trash (PostgreSQL)', { timeout: 30_000 }, () => {
  beforeAll(async () => { process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex'); const app = express(); app.use(express.json()); app.use('/api/mail', mailRoutes); await new Promise<void>(resolve => { server = app.listen(0, () => resolve()); }); base = `http://127.0.0.1:${listeningPort(server)}`; });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  beforeEach(async () => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.bulkMoveMessages.mockResolvedValue({ uidMap: new Map([[41, 141]]), succeeded: [41], failed: [] });
    mocks.runProviderMutation.mockResolvedValue({ status: 'confirmed', operationId: 'op', value: { id: 'graph-trash-id' }, replayed: false });
    mocks.moveGmailMessageToLabel.mockResolvedValue({ moved: true });
    await db(async c => { await c.query('DELETE FROM users WHERE id = $1', [USER_ID]); await c.query(`INSERT INTO users (id, username) VALUES ($1, 'na14-user')`, [USER_ID]);
      for (const [id, transport, connection] of [[IMAP_ACCOUNT, 'imap_smtp', null], [GMAIL_ACCOUNT, 'gmail_api', '00000000-0000-0000-0000-00000000d148'], [GRAPH_ACCOUNT, 'microsoft_graph', '00000000-0000-0000-0000-00000000d149']] as const) {
        if (connection) await c.query(`INSERT INTO provider_connections (id,user_id,provider,issuer,subject,status) VALUES ($1,$2,$3,$4,$5,'active')`, [connection, USER_ID, transport === 'gmail_api' ? 'google' : 'microsoft', `${transport}-issuer`, `${transport}-subject`]);
        await c.query(`INSERT INTO email_accounts (id,user_id,name,email_address,protocol,imap_host,mail_transport,provider_connection_id) VALUES ($1,$2,$3,$4,'imap','mail.test',$5,$6)`, [id, USER_ID, transport, `${transport}@test`, transport, connection]);
      }
      await c.query(`INSERT INTO messages (id,account_id,uid,folder,provider_message_id,subject,is_starred,plugin_annotations) VALUES ($1,$2,41,'INBOX',NULL,'imap',false,'{}'),($3,$4,42,'INBOX','gmail-1','gmail',true,'{"note":"keep"}'),($5,$6,43,'INBOX','graph-1','graph',true,'{"note":"keep"}')`, [IMAP_ID, IMAP_ACCOUNT, GMAIL_ID, GMAIL_ACCOUNT, GRAPH_ID, GRAPH_ACCOUNT]);
    });
  });
  it('does not feed Gmail/Graph UUIDs into the IMAP relocation CTE', async () => {
    const response = await fetch(`${base}/api/mail/messages/bulk-delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [IMAP_ID, GMAIL_ID, GRAPH_ID] }) });
    expect(response.status).toBe(200);
    const native = await db(c => c.query<{ id: string; folder: string; is_starred: boolean; plugin_annotations: unknown }>('SELECT id, folder, is_starred, plugin_annotations FROM messages WHERE id = ANY($1::uuid[]) ORDER BY id', [[GMAIL_ID, GRAPH_ID]]));
    expect(native.rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: GMAIL_ID, is_starred: true }), expect.objectContaining({ id: GRAPH_ID, is_starred: true })]));
  });
});
