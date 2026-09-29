import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool, query } from './db.js';
import { runMigrations } from './migrations.js';
import { listMessages } from './messageService.js';
import { readUnreadInboxCounts } from './unreadInboxCounts.js';
import { messageFolderMembershipSql } from './messageFolderMembership.js';

vi.mock('./db.js', async original => {
  const actual = await original<typeof import('./db.js')>();
  return { ...actual, query: vi.fn(actual.query) };
});
const hasPg = Boolean(process.env.DB_HOST && process.env.DB_NAME);
if (hasPg && (!['localhost', '127.0.0.1'].includes(process.env.DB_HOST ?? '') || !process.env.DB_NAME?.includes('test'))) {
  throw new Error('Folder membership regressions require an explicitly configured localhost test database');
}
const suite = hasPg ? describe : describe.skip;
const userId = randomUUID(), otherUser = randomUUID();
const gmail = randomUUID(), imap = randomUUID(), foreign = randomUUID(), disabled = randomUUID();
const marked = new Map<string, string>();

suite('folder membership SQL on PostgreSQL', () => {
  beforeAll(async () => {
    await runMigrations();
    await pool.query('INSERT INTO users(id,username) VALUES($1::uuid,$1::text),($2::uuid,$2::text)', [userId,otherUser]);
    for (const [id,owner,on] of [[gmail,userId,true],[imap,userId,true],[foreign,otherUser,true],[disabled,userId,false]] as const) {
      await pool.query(`INSERT INTO email_accounts(id,user_id,name,email_address,enabled,imap_host,mail_transport)
        VALUES($1,$2,'Synthetic account','owner@example.test',$3,'unused.example.test',$4)`,
        [id,owner,on,id===gmail?'gmail_api':'imap_smtp']);
    }
    const seeds = [
      ['primary',gmail,'INBOX',false,false], ['secondary',gmail,'Sent',false,false],
      ['twice',gmail,'INBOX',false,false], ['read',gmail,'INBOX',true,false],
      ['archived',gmail,'INBOX',false,true], ['wrong-label-owner',gmail,'Sent',false,false],
      ['imap',imap,'INBOX',false,false], ['foreign',foreign,'INBOX',false,false],
      ['disabled',disabled,'INBOX',false,false], ['deleted',gmail,'INBOX',false,false],
    ] as const;
    for (const [i,[name,account,folder,read,archived]] of seeds.entries()) {
      const id=randomUUID();marked.set(name,id);
      await pool.query(`INSERT INTO messages(id,account_id,uid,folder,message_id,subject,date,is_read,is_archived,is_deleted)
        VALUES($1,$2,$3::bigint,$4,$5,$6,NOW()-$3::bigint*interval '1 second',$7,$8,$9)`,
        [id,account,i+1,folder,`<${name}@example.test>`,name,read,archived,name==='deleted']);
    }
    for (const name of ['secondary','twice','archived','deleted','foreign','wrong-label-owner']) {
      // Include duplicate folder labels and malformed foreign account membership.
      const account = ['wrong-label-owner','foreign'].includes(name)?foreign:gmail;
      await pool.query(`INSERT INTO message_labels(message_id,account_id,label_id,folder_path)
        VALUES($1,$2,'INBOX','INBOX'),($1,$2,'custom-inbox','INBOX')`,[marked.get(name),account]);
    }
  }, 30_000);
  afterAll(async () => {
    // Delete only the synthetic fixtures owned by the two UUIDs above.
    // Clearing memberships in one batch avoids 40k cascading lookups.
    await pool.query('DELETE FROM message_labels WHERE account_id IN (SELECT id FROM email_accounts WHERE user_id=ANY($1::uuid[]))', [[userId,otherUser]]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[userId,otherUser]]);
  }, 30_000);

  it('preserves Gmail secondary labels, deduplication, unread filtering and account boundaries', async () => {
    const expected=['primary','secondary','twice'];
    for(const threaded of [false,true]) {
      const result=await listMessages({userId,accountId:gmail,unreadOnly:true,threaded});
      expect(result.total).toBe(3);
      expect(result.messages.map(row=>row.id).sort()).toEqual(expected.map(name=>marked.get(name)).sort());
      expect(result.messages.every(row=>row.folder==='INBOX'&&row.account_id===gmail)).toBe(true);
      const unified=await listMessages({userId,unreadOnly:true,threaded});
      expect(unified.total).toBe(4);
      expect(unified.messages.map(row=>row.id).sort()).toEqual([...expected,'imap'].map(name=>marked.get(name)).sort());
    }
    expect((await listMessages({userId,accountId:gmail,folder:'Archive'})).messages.map(row=>row.id)).toEqual([marked.get('archived')]);
    expect(await listMessages({userId,accountId:foreign})).toEqual({messages:[],total:0});
    expect(await listMessages({userId,accountId:disabled})).toEqual({messages:[],total:0});
    expect(await readUnreadInboxCounts(userId)).toEqual({total:4,byAccount:{[gmail]:3,[imap]:1}});
    const secondPage = await listMessages({userId,accountId:gmail,unreadOnly:true,limit:1,offset:1});
    expect(secondPage.total).toBe(3);
    expect(secondPage.messages.map(row=>row.id)).toEqual([marked.get('secondary')]);
  });

  it('is equivalent to the correlated predicate for every filter and account scope', async () => {
    for(const folder of ['INBOX','Sent','Archive','Missing']) for(const accounts of [[gmail],[gmail,imap],[foreign]]) {
      const old=`(m.folder=$2 OR EXISTS(SELECT 1 FROM message_labels ml WHERE ml.message_id=m.id AND ml.account_id=m.account_id AND ml.folder_path=$2))`;
      const next=messageFolderMembershipSql({accountIdsParam:1},2);
      const rows=await pool.query(`SELECT m.id FROM messages m WHERE m.account_id=ANY($1::uuid[]) AND (${old}) IS DISTINCT FROM (${next})`,[accounts,folder]);
      expect(rows.rows).toEqual([]);
    }
  });

  it('keeps the large multi-label mailbox plan bounded at normal and low working memory', async () => {
    const scale=await pool.query(`INSERT INTO email_accounts(user_id,name,email_address,imap_host,mail_transport)
      VALUES($1,'Scale','scale@example.test','unused.example.test','gmail_api') RETURNING id`,[otherUser]);
    const account=String(scale.rows[0].id);
    const seed = await pool.connect();
    try {
      await seed.query('BEGIN');
      await seed.query(`INSERT INTO messages(account_id,uid,folder,message_id,thread_id,subject,date,is_read)
      SELECT $1,s,CASE WHEN s%5=0 THEN 'Sent' ELSE 'INBOX' END,'<'||s||'@scale.example.test>',
        'thread:'||((s+2)/3),'Synthetic '||s,NOW()-s*interval '1 minute',s%19<>0
      FROM generate_series(1,40000) s`,[account]);
      // The pooled connection may have cached a sequential FK lookup when the
      // table held only the small fixture. Invalidate that plan before 120k
      // references, rather than spending the test in synthetic setup scans.
      await seed.query('ANALYZE messages');
      await seed.query(`INSERT INTO message_labels(message_id,account_id,label_id,folder_path)
      SELECT id,account_id,label,CASE label WHEN 'inbox' THEN 'INBOX' ELSE 'Work' END
      FROM messages CROSS JOIN (VALUES('inbox'),('work'),('extra')) l(label)
      WHERE account_id=$1`,[account]);
      await seed.query('COMMIT');
    } catch (error) {
      await seed.query('ROLLBACK');
      throw error;
    } finally { seed.release(); }
    await pool.query('ANALYZE messages');await pool.query('ANALYZE message_labels');
    vi.mocked(query).mockClear();
    const result=await listMessages({userId:otherUser,threaded:true,limit:50});
    expect(result.messages).toHaveLength(50);
    expect(result.total).toBe(13335); // 13,334 scale threads and one separately owned fixture.
    const calls=[...vi.mocked(query).mock.calls];
    const db = await pool.connect();
    try {
      await db.query('BEGIN READ ONLY');
      // A tiny transaction-local memory budget proves the join can spill;
      // it must not turn a large label set into repeated materialized scans.
      for (const memory of ['4MB', '64kB']) {
        await db.query(`SET LOCAL work_mem='${memory}'`);
        for (const [sql,params] of calls.filter(([sql])=>sql.includes('FROM messages m'))) {
          const plan=await db.query('EXPLAIN (FORMAT JSON) '+sql,params);
          const root=plan.rows[0]['QUERY PLAN'][0];
          expect(root.JIT).toBeUndefined();
          // Shape guard, not a flaky wall-clock threshold. The old correlated
          // or OR/IN plans cost millions and compiled for several seconds.
          expect(root.Plan['Total Cost']).toBeLessThan(100000);
        }
      }
    } finally {
      await db.query('ROLLBACK');
      db.release();
    }

  }, 60_000);
});
