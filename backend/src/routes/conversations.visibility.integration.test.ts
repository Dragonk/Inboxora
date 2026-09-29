import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const owner = vi.hoisted(() => ({ id: '' }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { session?: { userId: string } }, _res: unknown, next: () => void) => {
    req.session = { userId: owner.id }; next();
  },
}));
vi.mock('../index.js', () => ({ imapManager: {
  broadcast: vi.fn(), setFlag: vi.fn(), pluginFacade: {},
} }));
import { pool } from '../services/db.js';
import conversationRoutes from './conversations.js';
import { listeningPort } from '../test/net.js';

const enabled = Boolean(process.env.DB_HOST && process.env.DB_NAME);
if (enabled && (!['localhost', '127.0.0.1'].includes(process.env.DB_HOST ?? '') || !process.env.DB_NAME?.endsWith('_test'))) {
  throw new Error('Conversation visibility tests require an explicitly configured localhost test database');
}
const suite = enabled ? describe : describe.skip;
interface Copy { id: string; isRead: boolean }
interface Logical { id: string; copies: Copy[] }
interface Detail { summary: { logical_message_count: number; copy_count: number; unread_count: number; copies?: unknown }; logicalMessages: Logical[] }
interface Head { conversation_id: string; copy_count: number; unread_count: number; logical_message_count: number; logical_messages: Array<{ id: string; unread: boolean; isLatest: boolean }> }

suite('canonical conversation visibility (HTTP + PostgreSQL)', () => {
  let server: Server;
  let base: string;
  let accountId: string;
  let connectionId: string;
  let conversationId: string;
  let logicalId: string;
  let replyLogicalId: string;
  let canonicalId: string;
  let unreadId: string;
  let aliasId: string;
  const users: string[] = [];
  async function seedAccount(userId: string) {
    const account = randomUUID(); const connection = randomUUID();
    await pool.query(`INSERT INTO provider_connections(id,user_id,provider,issuer,subject)
      VALUES($1,$2,'microsoft','synthetic', $1::uuid::text)`, [connection, userId]);
    await pool.query(`INSERT INTO email_accounts(id,user_id,name,email_address,protocol,mail_transport,provider_connection_id)
      VALUES($1,$2,'Synthetic','ce@example.test','imap','microsoft_graph',$3)`, [account, userId, connection]);
    return { account, connection };
  }
  async function logical(date: string) {
    const id = randomUUID();
    await pool.query(`INSERT INTO logical_messages(id,user_id,account_id,conversation_id,canonical_message_id,subject,message_date)
      VALUES($1,$2,$3,$4,$1::uuid::text,'Synthetic conversation',$5)`, [id,owner.id,accountId,conversationId,date]);
    return id;
  }
  async function copy(logicalMessageId: string, uid: number, read: boolean, providerId: string | null, date: string) {
    const id = randomUUID();
    await pool.query(`INSERT INTO messages(id,account_id,uid,folder,logical_message_id,conversation_id,message_id,subject,is_read,provider_message_id,date,body_text,conversation_user_id)
      VALUES($1,$2,$3,'INBOX',$4,$5,'<shared@example.test>','Synthetic conversation',$6,$7,$8,$9,$10)`,
    [id,accountId,uid,logicalMessageId,conversationId,read,providerId,date,`Body of ${id}`,owner.id]);
    return id;
  }
  async function bind(legacy: string) {
    await pool.query(`INSERT INTO graph_legacy_message_bindings(legacy_message_id,canonical_message_id,account_id,connection_id,status)
      VALUES($1,$2,$3,$4,'bound')`, [legacy,canonicalId,accountId,connectionId]);
  }
  const detail = async () => {
    const response = await fetch(`${base}/conversations/${conversationId}`);
    expect(response.status).toBe(200);
    return await response.json() as Detail;
  };
  const list = async (query = '') => {
    const response = await fetch(`${base}/conversations?accountId=${accountId}${query}`);
    expect(response.status).toBe(200);
    return (await response.json() as { conversations: Head[] }).conversations;
  };
  beforeAll(async () => {
    const app = express(); app.use(express.json()); app.use('/api/mail', conversationRoutes);
    await new Promise<void>((resolve,reject) => { server = app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()); });
    base = `http://127.0.0.1:${listeningPort(server)}/api/mail`;
  });
  beforeEach(async () => {
    for (const user of users.splice(0)) await pool.query('DELETE FROM users WHERE id=$1', [user]);
    owner.id = randomUUID(); users.push(owner.id);
    await pool.query('INSERT INTO users(id,username) VALUES($1,$1::uuid::text)', [owner.id]);
    const seeded = await seedAccount(owner.id); accountId=seeded.account; connectionId=seeded.connection;
    conversationId=randomUUID();
    await pool.query(`INSERT INTO conversations(id,user_id,account_id,logical_message_count,copy_count,unread_count)
      VALUES($1,$2,$3,99,99,99)`, [conversationId,owner.id,accountId]);
    logicalId=await logical('2026-09-01T10:00:00Z'); replyLogicalId=await logical('2026-09-01T11:00:00Z');
    canonicalId=await copy(logicalId,1,true,'native-read','2026-09-01T10:00:00Z');
    unreadId=await copy(logicalId,2,false,'distinct-native-unread','2026-09-01T10:01:00Z');
    aliasId=await copy(logicalId,3,false,null,'2026-09-01T10:00:00Z'); await bind(aliasId);
    await copy(replyLogicalId,4,true,'native-reply','2026-09-01T11:00:00Z');
    const hiddenLogical=await logical('2026-09-01T12:00:00Z');
    const hidden=await copy(hiddenLogical,5,false,null,'2026-09-01T12:00:00Z'); await bind(hidden);
  });
  afterAll(async () => {
    await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
    for (const user of users) await pool.query('DELETE FROM users WHERE id=$1', [user]);
    await pool.end();
  });

  it('counts real physical copies and never turns hidden aliases into preview children', async () => {
    const [head] = await list('&unreadOnly=true');
    expect(head).toMatchObject({ conversation_id: conversationId, copy_count: 3, logical_message_count: 2, unread_count: 1 });
    expect(head.logical_messages.map(row => row.id)).toEqual([logicalId,replyLogicalId]);
    expect(head.logical_messages.filter(row => row.unread).map(row => row.id)).toEqual([logicalId]);
    expect(head.logical_messages.filter(row => row.isLatest).map(row => row.id)).toEqual([replyLogicalId]);
    const body = await detail();
    expect(body.logicalMessages).toHaveLength(2);
    expect(body.logicalMessages.flatMap(row => row.copies).filter(row => !row.isRead).map(row => row.id)).toEqual([unreadId]);
    expect(body.summary).toMatchObject({ logical_message_count: 2, copy_count: 3, unread_count: 1 });
    expect(body.summary).not.toHaveProperty('copies');
  });
  it('does not reuse stale ingest unread counts after a physical read changes', async () => {
    await pool.query('UPDATE messages SET is_read=true WHERE id=$1', [unreadId]);
    expect(await list('&unreadOnly=true')).toEqual([]);
    expect((await detail()).summary).toMatchObject({ logical_message_count: 2, copy_count: 3, unread_count: 0 });
  });
  it('does not serve hidden alias bodies or a body from another account', async () => {
    const path=`${base}/conversations/${conversationId}/logical-messages/${logicalId}/body`;
    expect((await fetch(`${path}?copyId=${aliasId}`)).status).toBe(404);
    const response=await fetch(`${path}?copyId=${canonicalId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ body_text: `Body of ${canonicalId}`, physical_copy_id: canonicalId });
    const foreign=randomUUID(); users.push(foreign);
    await pool.query('INSERT INTO users(id,username) VALUES($1,$1::uuid::text)',[foreign]);
    const {account}=await seedAccount(foreign); const foreignCopy=randomUUID(); const foreignConversation=randomUUID();
    await pool.query('INSERT INTO messages(id,account_id,uid,folder,subject,body_text) VALUES($1,$2,99,\'INBOX\',\'Foreign\',\'Private\')',[foreignCopy,account]);
    await pool.query('INSERT INTO conversations(id,user_id,account_id) VALUES($1,$2,$3)',[foreignConversation,foreign,account]);
    expect((await fetch(`${path}?copyId=${foreignCopy}`)).status).toBe(404);
    expect((await fetch(`${base}/conversations/${foreignConversation}`)).status).toBe(404);
  });
});
