import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool, query } from './db.js';
import { MAX_REPAIR_HEADER_BYTES, repairConversationHeadersBatch } from './conversationHeaderRepair.js';
import { rebuildConversationCopies } from './conversationRebuild.js';
import { conversationSerializeKey } from './conversationPersistence.js';
import { persistConversationCopyForRow } from './conversationRowIngest.js';

const hasPg = Boolean(process.env.DB_HOST && process.env.DB_NAME);
if (process.env.REQUIRE_CE_POSTGRES === '1' && !hasPg) {
  throw new Error('REQUIRE_CE_POSTGRES=1 requires DB_HOST and DB_NAME');
}
const describePg = hasPg ? describe : describe.skip;
const rawHeaders = 'Received: from mx.example.test\r\n\tby inbox.example.test\r\n'
  + 'Subject: Zażółć gęślą jaźń\r\nX-Trace: one\r\nX-Trace: two\r\n';
const legacyHeaders = (raw: string) => [...Buffer.from(raw).entries()]
  .map(([index, byte]) => `${index}: ${byte}`).join('\r\n');

type StoredRow = {
  conversation_raw_headers: string | null;
  logical_message_id: string | null;
  conversation_id: string | null;
};

describePg('conversation storage and ingest transactions (issue #16)', () => {
  let userId: string;
  let accountId: string;
  let nextUid: number;
  const account = () => ({ id: accountId, user_id: userId, imap_host: 'imap.example.test' });

  async function insert(messageId: string | null = `<${randomUUID()}@example.test>`) {
    const id = randomUUID();
    await query(`INSERT INTO messages
      (id, account_id, uid, folder, message_id, subject, from_email, date, body_text)
      VALUES ($1, $2, $3, 'INBOX', $4, 'Storage regression', 'sender@example.test', NOW(), 'body')`,
    [id, accountId, nextUid++, messageId]);
    return id;
  }

  async function stored(id: string): Promise<StoredRow> {
    return (await query<StoredRow>(`SELECT conversation_raw_headers, logical_message_id, conversation_id
      FROM messages WHERE id = $1`, [id])).rows[0];
  }

  beforeEach(async () => {
    userId = randomUUID(); accountId = randomUUID(); nextUid = 1;
    await query('INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3)',
      [userId, `issue16-${userId}`, 'test-only']);
    await query(`INSERT INTO email_accounts (id, user_id, name, email_address, protocol)
      VALUES ($1, $2, 'Storage regression', 'owner@example.test', 'imap')`, [accountId, userId]);
  });
  afterEach(async () => { vi.restoreAllMocks(); await query('DELETE FROM users WHERE id = $1', [userId]); });
  afterAll(async () => { await pool.end(); });

  it('persists the exact Buffer header once and leaves logical raw_headers empty', async () => {
    const id = await insert();
    await persistConversationCopyForRow(id, account(), { headers: Buffer.from(rawHeaders) });
    const row = await stored(id);
    expect(row.conversation_raw_headers).toBe(rawHeaders);
    expect(row.logical_message_id).not.toBeNull();
    const logical = await query<{ raw_headers: string | null }>('SELECT raw_headers FROM logical_messages WHERE id = $1', [row.logical_message_id]);
    expect(logical.rows[0].raw_headers).toBeNull();
  });

  it('does not write headers while another transaction owns the account lock', async () => {
    const id = await insert();
    const guard = await pool.connect();
    const key = conversationSerializeKey(userId, accountId);
    let operation: Promise<void> | undefined;
    let beforeUnlock: StoredRow | undefined;
    let waiting = false;
    try {
      await guard.query('SELECT pg_advisory_lock(hashtext($1), hashtext($2))', [key, key + ':2']);
      operation = persistConversationCopyForRow(id, account(), { headers: Buffer.from(rawHeaders) });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const state = await guard.query<{ waiting: boolean }>(`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'
            AND pid <> pg_backend_pid()) AS waiting`);
        if (state.rows[0].waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      beforeUnlock = await stored(id);
    } finally {
      await guard.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [key, key + ':2']);
      guard.release();
      await operation;
    }
    expect(waiting).toBe(true);
    expect(beforeUnlock?.conversation_raw_headers).toBeNull();
    expect((await stored(id)).conversation_raw_headers).toBe(rawHeaders);
  }, 15000);

  it('rolls back headers with a failed projection and records a recoverable failure', async () => {
    const id = await insert();
    const functionName = `issue16_fail_${userId.replaceAll('-', '')}`;
    const triggerName = `${functionName}_trigger`;
    await query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.account_id = '${accountId}'::uuid THEN RAISE EXCEPTION 'issue16 forced projection failure'; END IF; RETURN NEW; END $$`);
    await query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON logical_messages FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    try {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      await persistConversationCopyForRow(id, account(), { headers: Buffer.from(rawHeaders) });
      expect(errors).toHaveBeenCalledWith('Conversation persistence error:', 'issue16 forced projection failure');
      const row = await stored(id);
      expect(row.conversation_raw_headers).toBeNull();
      expect(row.logical_message_id).toBeNull();
      const failures = await query<{ count: number }>('SELECT COUNT(*)::int AS count FROM conversation_ingest_failures WHERE message_row_id = $1', [id]);
      expect(failures.rows[0].count).toBe(1);
    } finally {
      await query(`DROP TRIGGER ${triggerName} ON logical_messages`);
      await query(`DROP FUNCTION ${functionName}()`);
    }
  });

  it('does not mutate another owner’s headers before rejecting the projection', async () => {
    const id = await insert();
    await persistConversationCopyForRow(id, { ...account(), user_id: randomUUID() }, { headers: Buffer.from(rawHeaders) });
    expect(await stored(id)).toEqual({ conversation_raw_headers: null, logical_message_id: null, conversation_id: null });
  });

  it('preserves a no-Message-ID attachment when its legacy headers are decoded', async () => {
    const id = await insert(null);
    await persistConversationCopyForRow(id, account(), { headers: legacyHeaders(rawHeaders) });
    const before = await stored(id);
    expect(before.logical_message_id).not.toBeNull();
    await persistConversationCopyForRow(id, account(), { headers: Buffer.from(rawHeaders) });
    const after = await stored(id);
    expect(after.logical_message_id).toBe(before.logical_message_id);
    expect(after.conversation_id).toBe(before.conversation_id);
    expect(after.conversation_raw_headers).toBe(rawHeaders);
    const count = await query<{ count: number }>('SELECT COUNT(*)::int AS count FROM logical_messages WHERE account_id = $1', [accountId]);
    expect(count.rows[0].count).toBe(1);
  });

  it('projects concurrent copies of the same row without retries escaping into the failure queue', async () => {
    const id = await insert();
    await Promise.all(Array.from({ length: 12 }, () => persistConversationCopyForRow(id, account(), { headers: Buffer.from(rawHeaders) })));
    expect((await stored(id)).conversation_raw_headers).toBe(rawHeaders);
    const result = await query<{ logical: number; failures: number }>(`SELECT
      (SELECT COUNT(*)::int FROM logical_messages WHERE account_id = $1) AS logical,
      (SELECT COUNT(*)::int FROM conversation_ingest_failures WHERE account_id = $1) AS failures`, [accountId]);
    expect(result.rows[0]).toEqual({ logical: 1, failures: 0 });
  }, 15000);

  it('does not rewrite unchanged header columns on replays or partial envelopes', async () => {
    const id = await insert();
    const name = `issue16_audit_${userId.replaceAll('-', '')}`;
    await query(`CREATE TABLE ${name} (id uuid)`);
    await query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${id}'::uuid THEN INSERT INTO ${name} VALUES (NEW.id); END IF; RETURN NEW; END $$`);
    await query(`CREATE TRIGGER ${name} AFTER UPDATE OF conversation_raw_headers, conversation_thread_index, conversation_thread_topic
      ON messages FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      await persistConversationCopyForRow(id, account(), { headers: Buffer.from(rawHeaders) });
      await persistConversationCopyForRow(id, account(), { headers: Buffer.from(rawHeaders) });
      await persistConversationCopyForRow(id, account());
      const result = await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${name}`);
      expect(result.rows[0].count).toBe(1);
      expect((await stored(id)).conversation_raw_headers).toBe(rawHeaders);
    } finally {
      await query(`DROP TRIGGER ${name} ON messages`);
      await query(`DROP FUNCTION ${name}()`);
      await query(`DROP TABLE ${name}`);
    }
  });

  it('previews and repairs existing rows in bounded batches without changing message/thread identities', async () => {
    const ids = [await insert(null), await insert(), await insert()].sort();
    for (const id of ids) await persistConversationCopyForRow(id, account(), { headers: legacyHeaders(rawHeaders) });
    const before = await Promise.all(ids.map(stored));
    const preview = await repairConversationHeadersBatch({ userId, accountId, limit: 2 });
    expect(preview).toMatchObject({ scanned: 2, repairable: 2, repaired: 0, skipped: 0 });
    expect(preview.next).toBe(ids[1]);
    expect(preview.beforeBytes).toBe(2 * Buffer.byteLength(legacyHeaders(rawHeaders)));
    expect(preview.afterBytes).toBe(2 * Buffer.byteLength(rawHeaders));
    expect(await Promise.all(ids.map(stored))).toEqual(before);

    const first = await repairConversationHeadersBatch({ userId, accountId, limit: 2, apply: true });
    expect(first).toMatchObject({ scanned: 2, repaired: 2 });
    expect(first.next).toBe(ids[1]);
    const second = await repairConversationHeadersBatch({ userId, accountId, afterId: first.next, limit: 2, apply: true });
    expect(second).toMatchObject({ scanned: 1, repaired: 1, next: null });
    const after = await Promise.all(ids.map(stored));
    expect(after).toEqual(before.map(row => ({ ...row, conversation_raw_headers: rawHeaders })));
    const replay = await repairConversationHeadersBatch({ userId, accountId, apply: true });
    expect(replay).toMatchObject({ scanned: 3, repaired: 0, next: null });

    await rebuildConversationCopies({ userId, accountId, force: true, dryRun: false });
    expect(await Promise.all(ids.map(stored))).toEqual(after);
    const counts = await query<{ messages: number; logical: number }>(`SELECT
      (SELECT COUNT(*)::int FROM messages WHERE account_id = $1) AS messages,
      (SELECT COUNT(*)::int FROM logical_messages WHERE account_id = $1) AS logical`, [accountId]);
    expect(counts.rows[0]).toEqual({ messages: 3, logical: 3 });
  });

  it('leaves ambiguous and oversized values untouched and enforces account ownership', async () => {
    const valid = await insert(); const malformed = await insert(); const oversized = await insert();
    const encoded = legacyHeaders(rawHeaders);
    await query('UPDATE messages SET conversation_raw_headers = $1 WHERE id = $2', [encoded, valid]);
    await query('UPDATE messages SET conversation_raw_headers = $1 WHERE id = $2', ['0: not-a-byte', malformed]);
    await query("UPDATE messages SET conversation_raw_headers = '0: ' || repeat('1', $1) WHERE id = $2", [MAX_REPAIR_HEADER_BYTES, oversized]);
    const denied = await repairConversationHeadersBatch({ userId: randomUUID(), accountId, apply: true });
    expect(denied).toMatchObject({ scanned: 0, repaired: 0 });
    expect((await stored(valid)).conversation_raw_headers).toBe(encoded);
    const applied = await repairConversationHeadersBatch({ userId, accountId, apply: true });
    expect(applied).toMatchObject({ scanned: 3, repairable: 1, repaired: 1, skipped: 2 });
    expect((await stored(valid)).conversation_raw_headers).toBe(rawHeaders);
    expect((await stored(malformed)).conversation_raw_headers).toBe('0: not-a-byte');
    const size = await query<{ bytes: number }>('SELECT octet_length(conversation_raw_headers) AS bytes FROM messages WHERE id = $1', [oversized]);
    expect(size.rows[0].bytes).toBe(MAX_REPAIR_HEADER_BYTES + 3);
  });

  it('rolls back a whole repair batch when any update fails', async () => {
    const ids = [await insert(), await insert()].sort();
    const encoded = legacyHeaders(rawHeaders);
    await query('UPDATE messages SET conversation_raw_headers = $1 WHERE id = ANY($2::uuid[])', [encoded, ids]);
    const name = `issue16_repair_fail_${userId.replaceAll('-', '')}`;
    await query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${ids[1]}'::uuid THEN RAISE EXCEPTION 'issue16 forced repair failure'; END IF; RETURN NEW; END $$`);
    await query(`CREATE TRIGGER ${name} BEFORE UPDATE OF conversation_raw_headers ON messages FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      await expect(repairConversationHeadersBatch({ userId, accountId, apply: true })).rejects.toThrow('issue16 forced repair failure');
      expect((await stored(ids[0])).conversation_raw_headers).toBe(encoded);
      expect((await stored(ids[1])).conversation_raw_headers).toBe(encoded);
    } finally {
      await query(`DROP TRIGGER ${name} ON messages`);
      await query(`DROP FUNCTION ${name}()`);
    }
    // The failed batch released its advisory lock and can safely be retried.
    expect(await repairConversationHeadersBatch({ userId, accountId, apply: true })).toMatchObject({ repaired: 2 });
  });

  it('pages through large stretches of normal headers without an account-wide legacy LIKE scan', async () => {
    const total = 1200;
    const values: string[] = [];
    const params: unknown[] = [accountId];
    for (let index = 0; index < total; index++) {
      const base = params.length;
      values.push(`($1, $${base + 1}, 'INBOX', $${base + 2}, $${base + 3})`);
      params.push(10_000 + index, `normal-${index}@example.test`, `Subject: normal ${index}\r\nX-Pad: ${'x'.repeat(2048)}\r\n`);
    }
    await query(`INSERT INTO messages(account_id,uid,folder,message_id,conversation_raw_headers) VALUES ${values.join(',')}`, params);
    const damaged = await query<{ id: string }>(`INSERT INTO messages(account_id,uid,folder,message_id,conversation_raw_headers)
      VALUES($1,12050,'INBOX','legacy-tail@example.test',$2) RETURNING id`, [accountId, legacyHeaders(rawHeaders)]);

    let cursor: string | null = null;
    let repaired = 0;
    let scanned = 0;
    let batches = 0;
    do {
      const batch = await repairConversationHeadersBatch({ userId, accountId, afterId: cursor, limit: 250, apply: true });
      repaired += batch.repaired; scanned += batch.scanned; batches++;
      cursor = batch.next;
    } while (cursor !== null);

    expect(repaired).toBe(1);
    expect(scanned).toBe(total + 1);
    expect(batches).toBeGreaterThan(4);
    expect((await stored(damaged.rows[0].id)).conversation_raw_headers).toBe(rawHeaders);
  }, 30000);

  it('preserves a legacy UUID checkpoint even when the remaining UID is smaller', async () => {
    const previous = '10000000-0000-4000-8000-000000000010';
    const remaining = '20000000-0000-4000-8000-000000000020';
    await query(`INSERT INTO messages(id,account_id,uid,folder,conversation_raw_headers)
      VALUES($1,$3,900,'INBOX',$4),($2,$3,1,'INBOX',$5)`,
    [previous,remaining,accountId,rawHeaders,legacyHeaders(rawHeaders)]);
    const result = await repairConversationHeadersBatch({ userId, accountId, afterId: previous, limit: 10, apply: true });
    expect(result).toMatchObject({scanned:1,repaired:1,next:null});
    expect((await stored(previous)).conversation_raw_headers).toBe(rawHeaders);
    expect((await stored(remaining)).conversation_raw_headers).toBe(rawHeaders);
    await query('DELETE FROM messages WHERE id=$1',[previous]);
    await query('UPDATE messages SET conversation_raw_headers=$1 WHERE id=$2',[legacyHeaders(rawHeaders),remaining]);
    expect(await repairConversationHeadersBatch({userId,accountId,afterId:previous,apply:true})).toMatchObject({repaired:1});
  });

  it('restarts a prototype UID cursor instead of skipping lower-UID pending rows',async()=>{
    const id=await insert();await query('UPDATE messages SET conversation_raw_headers=$1 WHERE id=$2',[legacyHeaders(rawHeaders),id]);
    const old='v2:'+Buffer.from(JSON.stringify({uid:'9000000000000000',folder:'INBOX'})).toString('base64url');
    expect(await repairConversationHeadersBatch({userId,accountId,afterId:old,apply:true})).toMatchObject({scanned:1,repaired:1,next:null});
    expect(await repairConversationHeadersBatch({userId,accountId,apply:true})).toMatchObject({repaired:0});
  });

  it('caps dense pages at 50 payloads and resumes without losing the other rows',async()=>{
    await query(`INSERT INTO messages(account_id,uid,folder,conversation_raw_headers)
      SELECT $1,n,'INBOX',$2 FROM generate_series(1,121) n`,[accountId,legacyHeaders(rawHeaders)]);
    let cursor: string|null=null;
    const passes=[];
    do {
      const result=await repairConversationHeadersBatch({userId,accountId,afterId:cursor,limit:250,apply:true});
      passes.push(result);cursor=result.next;
    } while(cursor!==null);
    expect(passes.map(p=>p.repaired)).toEqual([50,50,21]);
    expect(passes.reduce((n,p)=>n+p.scanned,0)).toBe(121);
    expect((await query('SELECT COUNT(*)::int AS n FROM messages WHERE account_id=$1 AND conversation_raw_headers=$2',[accountId,rawHeaders])).rows[0].n).toBe(121);
  });

  it('does not skip a pending row that moves to a lower UID between pages',async()=>{
    const ids=[await insert(),await insert()].sort();
    await query('UPDATE messages SET conversation_raw_headers=$1 WHERE id=ANY($2::uuid[])',[legacyHeaders(rawHeaders),ids]);
    const first=await repairConversationHeadersBatch({userId,accountId,limit:1,apply:true});
    await query("UPDATE messages SET uid=0,folder='Archive' WHERE id=$1",[ids[1]]);
    const second=await repairConversationHeadersBatch({userId,accountId,afterId:first.next,limit:2,apply:true});
    expect(first.next).toBe(ids[0]);expect(second).toMatchObject({repaired:1,next:null});
  });


  it('repairs all same-UID copies and does not change thread IDs on dense pagination',async()=>{
    const ids=[await insert(),await insert()];
    await query("UPDATE messages SET folder=CASE WHEN id=$1 THEN 'A' ELSE 'B' END,uid=42,conversation_raw_headers=$3 WHERE id=ANY($2::uuid[])",[ids[0],ids,legacyHeaders(rawHeaders)]);
    const first=await repairConversationHeadersBatch({userId,accountId,limit:1,apply:true});
    const second=await repairConversationHeadersBatch({userId,accountId,afterId:first.next,limit:2,apply:true});
    expect(first.repaired+second.repaired).toBe(2);
    expect((await Promise.all(ids.map(stored))).every(row=>row.conversation_raw_headers===rawHeaders)).toBe(true);
  });

  it('also limits read bytes for malformed headers and reports every skipped value once',async()=>{
    await query(`INSERT INTO messages(account_id,uid,folder,conversation_raw_headers)
      SELECT $1,n,'INBOX','0: invalid'||repeat('x',12*1024*1024) FROM generate_series(1,3) n`,[accountId]);
    const first=await repairConversationHeadersBatch({userId,accountId,limit:250,apply:true});
    expect(first).toMatchObject({repaired:0,skipped:2,scanned:2});expect(first.next).not.toBeNull();
    const second=await repairConversationHeadersBatch({userId,accountId,afterId:first.next,limit:250,apply:true});
    expect(second).toMatchObject({repaired:0,skipped:1,scanned:1,next:null});
  });

});
