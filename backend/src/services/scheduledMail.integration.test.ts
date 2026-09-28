import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool, query } from './db.js';
import * as queue from './scheduledMail.js';
import { previewScheduledMail } from './scheduledMailPreview.js';
import type { SendRequestBody } from './sendMail.js';

const required = process.env.REQUIRE_SCHEDULED_MAIL_POSTGRES === '1';
const configured = Boolean(process.env.DB_HOST && process.env.DB_NAME);
const suite = required || configured ? describe : describe.skip;
const schema = `scheduled_test_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectionTimeoutMillis: 3000 });
let created = false;
let user: string; let outsider: string; let account: string; let otherAccount: string;
let message: SendRequestBody;
const instant = () => new Date(Date.now() + 3600_000).toISOString();
const prepare = vi.fn<queue.SendExecutor>(async (_user, payload, key, options) => {
  expect(key).toBeNull(); expect(options).toMatchObject({ prepareOnly: true });
  return { status: 200, body: {}, prepared: { payload: structuredClone(payload), senderEmail: 'sender@example.test' } };
});
const enqueue = (key = randomUUID(), overrides: Record<string, unknown> = {}) => queue.enqueueScheduledMail(user,
  { mode: 'schedule', timeZone: 'Europe/Prague', scheduledAt: instant(), message, ...overrides }, key, prepare);
async function stored(id: string) { return (await query('SELECT * FROM scheduled_mail WHERE id=$1', [id])).rows[0]; }
async function due(id: string) { await query("UPDATE scheduled_mail SET scheduled_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]); }
async function claimed(id: string) {
  await due(id); const row = await queue.claimScheduledMail(); expect(row?.id).toBe(id);
  if (!row) throw new Error('Expected claim'); return row;
}
const ok = { status: 200, body: { ok: true } };

suite('durable scheduled mail with real PostgreSQL and fake preparation', () => {
  beforeAll(async () => {
    if (!configured) throw new Error('REQUIRE_SCHEDULED_MAIL_POSTGRES=1 requires DB_HOST and DB_NAME');
    const ready = await admin.query("SELECT to_regclass('public.scheduled_mail') AS queue");
    if (!ready.rows[0]?.queue) throw new Error('Apply migration 0152 before scheduled-mail integration tests');
    await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
    // Clone deployed columns/checks/indexes, preserving foreign-key definitions explicitly.
    for (const table of ['users', 'email_accounts', 'send_idempotency', 'scheduled_mail', 'folders', 'messages']) {
      await admin.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
      const constraints = await admin.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid=$1::regclass AND contype='f'`, [`public.${table}`]);
      for (const { definition } of constraints.rows) {
        if (!/REFERENCES (?:public\.)?(users|email_accounts)\(/.test(definition)) continue;
        const local = definition.replace(/REFERENCES (?:public\.)?(users|email_accounts)\(/, `REFERENCES "${schema}".$1(`);
        await admin.query(`ALTER TABLE "${schema}".${table} ADD ${local}`);
      }
    }
    const migration = readFileSync(new URL('../../migrations/0154_mail_merge_batches.sql', import.meta.url), 'utf8');
    const migrationClient = await admin.connect();
    try {
      await migrationClient.query('BEGIN');
      await migrationClient.query(`SET LOCAL search_path TO "${schema}"`);
      await migrationClient.query(migration);
      await migrationClient.query('COMMIT');
    } catch (error) { await migrationClient.query('ROLLBACK'); throw error; }
    finally { migrationClient.release(); }
    pool.options.options = `-c statement_timeout=30000 -c search_path=${schema}`;
  });
  beforeEach(async () => {
    await query('TRUNCATE messages, folders, mail_merge_batches, scheduled_mail, send_idempotency, email_accounts, users CASCADE');
    user = randomUUID(); outsider = randomUUID(); account = randomUUID(); otherAccount = randomUUID();
    await query('INSERT INTO users(id,username) VALUES ($1,$2),($3,$4)', [user, user, outsider, outsider]);
    await query("INSERT INTO email_accounts(id,user_id,name,email_address) VALUES ($1,$3,'Test','sender@example.test'),($2,$4,'Other','other@example.test')", [account, otherAccount, user, outsider]);
    message = { accountId: account, body: 'original body', bodyIsHtml: false, subject: 'original',
      to: ['Accepted <accepted@example.test>', 'Rejected <to@example.test>'], cc: ['cc@example.test'], bcc: ['private@example.test'],
      attachments: [{ filename: 'bytes.bin', content: 'AAH/', contentType: 'application/octet-stream' }],
      editedSignature: '<p>Frozen signature</p>', editedSignatureIsHtml: true };
    prepare.mockReset();
    prepare.mockImplementation(async (_user, payload, key, options) => {
      expect(key).toBeNull(); expect(options).toMatchObject({ prepareOnly: true });
      return { status: 200, body: {}, prepared: { payload: structuredClone(payload), senderEmail: 'sender@example.test' } };
    });
  });
  afterAll(async () => {
    await pool.end();
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it('persists exact time and frozen content; lists metadata only; scopes ownership and cascades account deletion', async () => {
    const scheduledAt = instant(); const row = await enqueue(undefined, { scheduledAt });
    expect(row.scheduledAt.toISOString()).toBe(scheduledAt);
    expect((await stored(row.id)).payload).toEqual({ payload: message, senderEmail: 'sender@example.test' });
    expect(await queue.listScheduledMail(outsider)).toEqual([]);
    const [summary] = await queue.listScheduledMail(user);
    expect(summary).toEqual(row); expect(summary).not.toHaveProperty('payload');
    await expect(queue.editScheduledMail(outsider, row.id, 1)).rejects.toMatchObject({ status: 409 });
    await query('DELETE FROM email_accounts WHERE id=$1', [account]);
    expect(await stored(row.id)).toBeUndefined();
  });

  it('atomically queues one private item per unique To/Cc/Bcc address and replays after cancellation', async () => {
    const key = randomUUID();
    message.to = ['Accepted <accepted@example.test>', 'accepted@example.test'];
    message.cc = ['cc@example.test']; message.bcc = ['CC@example.test', 'private@example.test'];
    await query('UPDATE users SET preferences=$2 WHERE id=$1', [user, { undoSendSeconds: 15 }]);
    const input = { message };
    const receipt = await queue.enqueueMailMerge(user, input, key, prepare);
    expect(receipt.count).toBe(3);
    expect(receipt.items).toHaveLength(3);
    expect(prepare).toHaveBeenCalledTimes(3);
    const rows = (await query<{ payload: { payload: SendRequestBody } }>('SELECT payload FROM scheduled_mail ORDER BY id')).rows;
    expect(rows.map(row => row.payload.payload.to?.[0]).sort()).toEqual([
      'Accepted <accepted@example.test>', 'cc@example.test', 'private@example.test'].sort());
    for (const row of rows) {
      expect(row.payload.payload.cc).toEqual([]);
      expect(row.payload.payload.bcc).toEqual([]);
      expect(row.payload.payload.attachments).toEqual(message.attachments);
      expect(row.payload.payload.editedSignature).toBe(message.editedSignature);
    }
    expect(receipt.scheduledAt.getTime()).toBeGreaterThanOrEqual(Date.now() + 14_000);
    await queue.cancelScheduledMail(user, receipt.items[0].id, 1);
    await query("UPDATE scheduled_mail SET state='sent', payload='{}'::jsonb WHERE id=$1", [receipt.items[1].id]);
    expect(await queue.enqueueMailMerge(user, input, key, prepare)).toMatchObject({ id: receipt.id, count: 3 });
    expect(prepare).toHaveBeenCalledTimes(3);
    await expect(queue.enqueueMailMerge(user, { message: { ...message, subject: 'changed' } }, key, prepare))
      .rejects.toMatchObject({ code: 'MAIL_MERGE_KEY_MISMATCH' });
    expect((await query('SELECT count(*)::int AS n FROM scheduled_mail')).rows[0].n).toBe(3);
    await expect(queue.enqueueMailMerge(outsider, input, key, prepare)).rejects.toMatchObject({ code: 'SCHEDULE_ACCOUNT_MISSING' });
    await expect(queue.enqueueMailMerge(user, { message: { ...message, accountId: otherAccount } }, randomUUID(), prepare))
      .rejects.toMatchObject({ code: 'SCHEDULE_ACCOUNT_MISSING' });
    expect((await query('SELECT count(*)::int AS n FROM mail_merge_batches')).rows[0].n).toBe(1);
  });

  it('starts zero-delay merge after all preparation and rolls back when capacity cannot fit every item', async () => {
    message.to = ['first@example.test', 'second@example.test']; message.cc = []; message.bcc = [];
    let finished = 0;
    prepare.mockImplementation(async (_user, payload) => {
      await new Promise(resolve => setTimeout(resolve, 10)); finished = Date.now();
      return { status: 200, body: {}, prepared: { payload, senderEmail: 'sender@example.test' } };
    });
    const receipt = await queue.enqueueMailMerge(user, { message }, randomUUID(), prepare);
    expect(receipt.scheduledAt.getTime()).toBeGreaterThanOrEqual(finished);
    expect(receipt.scheduledAt.getTime()).toBeLessThanOrEqual(Date.now());
    await query(`INSERT INTO scheduled_mail(id,user_id,account_id,idempotency_key,request_fingerprint,mode,scheduled_at,time_zone,payload)
      SELECT gen_random_uuid(),$1,$2,'fixture-'||n,repeat('a',64),'schedule',clock_timestamp()+interval '1 day','UTC','{}'::jsonb FROM generate_series(1,97) n`, [user, account]);
    await expect(queue.enqueueMailMerge(user, { message }, randomUUID(), prepare)).rejects.toMatchObject({ code: 'SCHEDULE_QUEUE_FULL' });
    expect((await query('SELECT count(*)::int AS n FROM mail_merge_batches')).rows[0].n).toBe(1);
    expect((await query('SELECT count(*)::int AS n FROM scheduled_mail')).rows[0].n).toBe(99);
  });

  it('starts the full Undo window after slow batch snapshot writes complete', async () => {
    await query('UPDATE users SET preferences=$2 WHERE id=$1', [user, { undoSendSeconds: 15 }]);
    message.to = ['first@example.test']; message.cc = ['second@example.test']; message.bcc = ['third@example.test'];
    await query(`CREATE FUNCTION delay_merge_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.6); RETURN NEW; END $$;
      CREATE TRIGGER delay_merge_snapshot BEFORE INSERT ON scheduled_mail
      FOR EACH ROW EXECUTE FUNCTION delay_merge_snapshot()`);
    try {
      const receipt = await queue.enqueueMailMerge(user, { message }, randomUUID(), prepare);
      // Three slow inserts consume more than one second, but not the user's
      // fifteen-second opportunity to undo once the atomic batch is visible.
      expect(receipt.scheduledAt.getTime()).toBeGreaterThanOrEqual(Date.now() + 14_000);
      const rows = (await query<{ scheduled_at: Date }>('SELECT scheduled_at FROM scheduled_mail')).rows;
      expect(rows).toHaveLength(3);
      expect(rows.every(row => row.scheduled_at.getTime() === receipt.scheduledAt.getTime())).toBe(true);
    } finally {
      await query('DROP TRIGGER delay_merge_snapshot ON scheduled_mail');
      await query('DROP FUNCTION delay_merge_snapshot()');
    }
  });

  it('serializes concurrent retries of one merge key into a single batch', async () => {
    message.to = ['first@example.test', 'second@example.test']; message.cc = []; message.bcc = [];
    const key = randomUUID();
    const receipts = await Promise.all(Array.from({ length: 3 }, () => queue.enqueueMailMerge(user, { message }, key, prepare)));
    expect(new Set(receipts.map(receipt => receipt.id)).size).toBe(1);
    expect((await query('SELECT count(*)::int AS n FROM mail_merge_batches')).rows[0].n).toBe(1);
    expect((await query('SELECT count(*)::int AS n FROM scheduled_mail')).rows[0].n).toBe(2);
  });

  it('leaves no batch or children when a later recipient fails preparation', async () => {
    message.to = ['first@example.test', 'second@example.test']; message.cc = []; message.bcc = [];
    prepare.mockImplementationOnce(async (_user, payload) => ({ status: 200, body: {}, prepared: {
      payload, senderEmail: 'sender@example.test' } }));
    prepare.mockImplementationOnce(async () => ({ status: 409, body: { code: 'SCHEDULE_SENDER_CHANGED' } }));
    await expect(queue.enqueueMailMerge(user, { message }, randomUUID(), prepare))
      .rejects.toMatchObject({ code: 'SCHEDULE_SENDER_CHANGED' });
    expect((await query('SELECT count(*)::int AS n FROM scheduled_mail')).rows[0].n).toBe(0);
    expect((await query('SELECT count(*)::int AS n FROM mail_merge_batches')).rows[0].n).toBe(0);
  });

  it('rolls back earlier children when a later insertion fails', async () => {
    message.to = ['first@example.test', 'second@example.test']; message.cc = []; message.bcc = [];
    await query(`ALTER TABLE scheduled_mail ADD CONSTRAINT reject_second_merge_child
      CHECK (idempotency_key NOT LIKE 'merge:%:1')`);
    try {
      await expect(queue.enqueueMailMerge(user, { message }, randomUUID(), prepare)).rejects.toThrow();
      expect((await query('SELECT count(*)::int AS n FROM scheduled_mail')).rows[0].n).toBe(0);
      expect((await query('SELECT count(*)::int AS n FROM mail_merge_batches')).rows[0].n).toBe(0);
    } finally {
      await query('ALTER TABLE scheduled_mail DROP CONSTRAINT reject_second_merge_child');
    }
  });

  it('replays the batch receipt after its account and child rows are deleted', async () => {
    message.to = ['first@example.test', 'second@example.test']; message.cc = []; message.bcc = [];
    const key = randomUUID(); const input = { message };
    const receipt = await queue.enqueueMailMerge(user, input, key, prepare);
    await query('DELETE FROM email_accounts WHERE id=$1', [account]);
    const replay = await queue.enqueueMailMerge(user, input, key, prepare);
    expect(replay).toMatchObject({ id: receipt.id, count: 2, items: [] });
    expect((await query('SELECT count(*)::int AS n FROM mail_merge_batches')).rows[0].n).toBe(1);
    expect((await query('SELECT count(*)::int AS n FROM scheduled_mail')).rows[0].n).toBe(0);
  });

  it('replays immutable enqueue keys after cancellation and rejects changed bodies without preparing twice', async () => {
    const key = randomUUID(); const scheduledAt = instant(); const input = { scheduledAt };
    const row = await enqueue(key, input); await queue.cancelScheduledMail(user, row.id, 1);
    expect(await enqueue(key, input)).toMatchObject({ id: row.id, state: 'cancelled', revision: 2 });
    await expect(enqueue(key, { ...input, message: { ...message, body: 'changed' } })).rejects.toMatchObject({ code: 'SCHEDULE_KEY_MISMATCH' });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect((await query('SELECT count(*)::int AS n FROM scheduled_mail')).rows[0].n).toBe(1);
  });

  it('serializes concurrent enqueue and enforces the active quota at the boundary', async () => {
    const key = randomUUID(); const input = { scheduledAt: instant() };
    const copies = await Promise.all(Array.from({ length: 8 }, () => enqueue(key, input)));
    expect(new Set(copies.map(row => row.id)).size).toBe(1);
    await query(`INSERT INTO scheduled_mail(id,user_id,account_id,idempotency_key,request_fingerprint,mode,scheduled_at,time_zone,payload)
      SELECT gen_random_uuid(),$1,$2,'fixture-'||n,repeat('a',64),'schedule',clock_timestamp()+interval '1 day','UTC','{}'::jsonb FROM generate_series(1,98) n`, [user, account]);
    const results = await Promise.allSettled([enqueue(), enqueue()]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'SCHEDULE_QUEUE_FULL' } });
    expect((await query('SELECT count(*)::int AS n FROM scheduled_mail')).rows[0].n).toBe(100);
  });

  it('rejects disabled undo and starts 60 seconds only after preparation finishes', async () => {
    await expect(enqueue(undefined, { mode: 'undo' })).rejects.toMatchObject({ status: 400 });
    expect(prepare).not.toHaveBeenCalled();
    await query('UPDATE users SET preferences=$2 WHERE id=$1', [user, { undoSendSeconds: 60 }]);
    let finished = 0;
    prepare.mockImplementationOnce(async (_user, payload) => {
      await new Promise(resolve => setTimeout(resolve, 30)); finished = Date.now();
      return { status: 200, body: {}, prepared: { payload, senderEmail: 'sender@example.test' } };
    });
    const row = await enqueue(undefined, { mode: 'undo' });
    expect(row.scheduledAt.getTime()).toBeGreaterThanOrEqual(finished + 60_000);
    expect(row.scheduledAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('rejects foreign account enqueue and unauthorized or stale mutations without changing the stored row', async () => {
    await expect(enqueue(undefined, { message: { ...message, accountId: otherAccount } })).rejects.toMatchObject({ status: 404 });
    const row = await enqueue(); const before = await stored(row.id);
    for (const [actor, revision] of [[outsider, 1], [user, 2]] as const) {
      await expect(queue.editScheduledMail(actor, row.id, revision)).rejects.toMatchObject({ status: 409 });
      await expect(queue.cancelScheduledMail(actor, row.id, revision)).rejects.toMatchObject({ status: 409 });
      await expect(queue.rescheduleMail(actor, row.id, { revision, scheduledAt: instant(), timeZone: 'UTC' })).rejects.toMatchObject({ status: 409 });
      await expect(queue.updateScheduledMail(actor, row.id, { revision, message, keepEditing: true }, prepare)).rejects.toMatchObject({ status: 409 });
    }
    expect(await stored(row.id)).toEqual(before);
  });

  it('refuses replacement using a foreign account and binds enqueue receipts to the original account', async () => {
    const key = randomUUID(); const scheduledAt = instant(); const row = await enqueue(key, { scheduledAt });
    await queue.editScheduledMail(user, row.id, 1); const before = await stored(row.id);
    await expect(queue.updateScheduledMail(user, row.id, { revision: 1, keepEditing: true,
      message: { ...message, accountId: otherAccount } }, prepare)).rejects.toMatchObject({ status: 409 });
    expect(await stored(row.id)).toEqual(before);
    const sameOwnerAccount = randomUUID();
    await query("INSERT INTO email_accounts(id,user_id,name,email_address) VALUES ($1,$2,'Second','second@example.test')", [sameOwnerAccount, user]);
    await expect(enqueue(key, { scheduledAt, message: { ...message, accountId: sameOwnerAccount } })).rejects.toMatchObject({ code: 'SCHEDULE_KEY_MISMATCH' });
    expect(await stored(row.id)).toEqual(before);
  });

  it('pauses autosave past its due time, persists edited bytes and signature through reopening, and replays lost acknowledgements', async () => {
    const row = await enqueue(); await queue.editScheduledMail(user, row.id, 1); await due(row.id);
    const original = await stored(row.id);
    const edited = { ...message, body: 'saved while closed', attachments: [{ filename: 'new.bin', content: '/wAA' }], editedSignature: 'saved signature' };
    const action = { revision: 1, message: edited, keepEditing: true };
    const saved = await queue.updateScheduledMail(user, row.id, action, prepare);
    expect(saved).toMatchObject({ state: 'editing', revision: 2, timeZone: row.timeZone, scheduledAt: original.scheduled_at });
    expect(await queue.claimScheduledMail()).toBeNull();
    expect((await queue.editScheduledMail(user, row.id, 2)).payload.payload).toEqual(edited);
    expect(await queue.updateScheduledMail(user, row.id, action, prepare)).toEqual(saved);
    await expect(queue.updateScheduledMail(user, row.id, { ...action, message }, prepare)).rejects.toMatchObject({ status: 409 });
  });

  it.each([0, 60])('sendNow requeues the same row using persisted undo preference %i and replays even after sent', async seconds => {
    const row = await enqueue(); await queue.editScheduledMail(user, row.id, 1);
    await query('UPDATE users SET preferences=$2 WHERE id=$1', [user, { undoSendSeconds: seconds }]);
    const action = { revision: 1, message, sendNow: true, timeZone: 'UTC' }; const before = Date.now();
    const saved = await queue.updateScheduledMail(user, row.id, action, prepare);
    expect(saved).toMatchObject({ id: row.id, state: 'pending', mode: 'undo', revision: 2 });
    expect(saved.scheduledAt.getTime()).toBeGreaterThanOrEqual(before + seconds * 1000);
    expect(saved.scheduledAt.getTime()).toBeLessThanOrEqual(Date.now() + seconds * 1000);
    const claim = await claimed(row.id); expect(await queue.beginScheduledDispatch(claim)).toBe(true);
    await queue.completeScheduledMail(claim, ok);
    expect(await queue.updateScheduledMail(user, row.id, action, prepare)).toMatchObject({ id: row.id, state: 'sent', revision: 2 });
    expect((await query('SELECT count(*)::int AS n FROM scheduled_mail')).rows[0].n).toBe(1);
  });

  it('validates mutually exclusive update actions and requeues an exact scheduled replacement', async () => {
    const row = await enqueue(); await queue.editScheduledMail(user, row.id, 1);
    await expect(queue.updateScheduledMail(user, row.id, { revision: 1, message, keepEditing: true, sendNow: true }, prepare)).rejects.toMatchObject({ status: 400 });
    const scheduledAt = instant(); const action = { revision: 1, message, scheduledAt, timeZone: 'UTC' };
    const saved = await queue.updateScheduledMail(user, row.id, action, prepare);
    expect(saved).toMatchObject({ id: row.id, state: 'pending', mode: 'schedule', revision: 2 });
    expect(saved.scheduledAt.toISOString()).toBe(scheduledAt);
    expect(await queue.updateScheduledMail(user, row.id, action, prepare)).toEqual(saved);
  });

  it.each(['save', 'sendNow', 'schedule'])('applies simultaneous identical %s retries once and conflicts different edits', async kind => {
    const row = await enqueue(); await queue.editScheduledMail(user, row.id, 1);
    const action = { revision: 1, message, ...(kind === 'save' ? { keepEditing: true }
      : kind === 'sendNow' ? { sendNow: true, timeZone: 'UTC' } : { scheduledAt: instant(), timeZone: 'UTC' }) };
    const retries = await Promise.all(Array.from({ length: 6 }, () => queue.updateScheduledMail(user, row.id, action, prepare)));
    expect(retries.every(r => r.revision === 2 && r.id === row.id)).toBe(true);
    await queue.editScheduledMail(user, row.id, 2);
    const edits = await Promise.allSettled(['A', 'B'].map(body => queue.updateScheduledMail(user, row.id,
      { revision: 2, message: { ...message, body }, keepEditing: true }, prepare)));
    expect(edits.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(edits.find(r => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect((await stored(row.id)).revision).toBe(3);
  });

  it('reschedules before due without rebuilding frozen payload', async () => {
    const row = await enqueue(); const before = await stored(row.id); const scheduledAt = new Date(Date.now() + 7200_000).toISOString();
    const saved = await queue.rescheduleMail(user, row.id, { revision: 1, scheduledAt, timeZone: 'UTC' });
    expect(saved.revision).toBe(2); expect(saved.scheduledAt.toISOString()).toBe(scheduledAt);
    expect((await stored(row.id)).payload).toEqual(before.payload); expect(prepare).toHaveBeenCalledTimes(1);
    expect(await queue.claimScheduledMail()).toBeNull();
  });

  it('allows only one worker to claim and excludes cancellation or editing after claim', async () => {
    const row = await enqueue(); await due(row.id);
    const claims = await Promise.all(Array.from({ length: 8 }, () => queue.claimScheduledMail()));
    expect(claims.filter(Boolean)).toHaveLength(1);
    await expect(queue.cancelScheduledMail(user, row.id, 1)).rejects.toMatchObject({ status: 409 });
    await expect(queue.editScheduledMail(user, row.id, 1)).rejects.toMatchObject({ status: 409 });
  });

  it('arbitrates simultaneous pause/cancel/claim without dispatching a paused or cancelled row', async () => {
    const row = await enqueue(); await due(row.id);
    const results = await Promise.allSettled([queue.editScheduledMail(user, row.id, 1), queue.cancelScheduledMail(user, row.id, 1), queue.claimScheduledMail()]);
    const state = (await stored(row.id)).state;
    const claimResult = results[2];
    if (state === 'preparing') {
      expect(results[0].status).toBe('rejected'); expect(results[1].status).toBe('rejected');
      expect(claimResult).toMatchObject({ status: 'fulfilled', value: { id: row.id } });
    } else {
      expect(['editing', 'cancelled']).toContain(state);
      expect(claimResult).toMatchObject({ status: 'fulfilled', value: null });
      expect(await queue.claimScheduledMail()).toBeNull();
    }
  });

  it('recovers expired preparation with a new revision and rejects every stale lease operation', async () => {
    const row = await enqueue(); const stale = await claimed(row.id);
    await query("UPDATE scheduled_mail SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [row.id]);
    await queue.recoverScheduledMail();
    expect(await stored(row.id)).toMatchObject({ state: 'pending', revision: 2, lease_token: null });
    const current = await queue.claimScheduledMail(); expect(current?.lease_token).not.toBe(stale.lease_token);
    const before = await stored(row.id);
    expect(await queue.renewScheduledClaim(stale)).toBe(false); expect(await queue.beginScheduledDispatch(stale)).toBe(false);
    await queue.completeScheduledMail(stale, ok); expect(await stored(row.id)).toEqual(before);
  });

  it('parks expired sending uncertain and reconciles observed durable success without executing send', async () => {
    const row = await enqueue(); const claim = await claimed(row.id); expect(await queue.beginScheduledDispatch(claim)).toBe(true);
    await query("UPDATE scheduled_mail SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [row.id]);
    await queue.recoverScheduledMail();
    expect(await stored(row.id)).toMatchObject({ state: 'uncertain', revision: 1, lease_token: null });
    expect(await queue.claimScheduledMail()).toBeNull();
    await expect(queue.editScheduledMail(user, row.id, 1)).rejects.toMatchObject({ status: 409 });
    await expect(queue.rescheduleMail(user, row.id, { revision: 1, scheduledAt: instant(), timeZone: 'UTC' })).rejects.toMatchObject({ status: 409 });
    await query(`INSERT INTO send_idempotency(user_id,idempotency_key,request_fingerprint,status,intent_token,result)
      VALUES ($1,$2,$3,'completed',$4,$5)`, [user, `scheduled:${row.id}:1`, 'a'.repeat(64), randomUUID(), ok.body]);
    prepare.mockClear(); await queue.recoverScheduledMail();
    expect(await stored(row.id)).toMatchObject({ state: 'sent', payload: {}, result: { ok: true } });
    expect(prepare).not.toHaveBeenCalled(); expect(await queue.claimScheduledMail()).toBeNull();
  });

  it('retains only rejected original To/Cc/Bcc roles after partial delivery and never requeues accepted recipients', async () => {
    const row = await enqueue(); const claim = await claimed(row.id); await queue.beginScheduledDispatch(claim);
    await queue.completeScheduledMail(claim, { status: 200, body: { ok: true, partialDelivery: true,
      accepted: ['accepted@example.test'], rejected: ['TO@example.test', 'cc@example.test', 'private@example.test'] } });
    const partial = await queue.editScheduledMail(user, row.id, 1);
    expect(partial.payload.payload).toEqual({ ...message, to: ['Rejected <to@example.test>'] });
    await queue.updateScheduledMail(user, row.id, { revision: 1, message: partial.payload.payload, sendNow: true, timeZone: 'UTC' }, prepare);
    const next = await claimed(row.id);
    expect(next.payload.payload.to).toEqual(['Rejected <to@example.test>']);
    expect(next.payload.payload.cc).toEqual(['cc@example.test']); expect(next.payload.payload.bcc).toEqual(['private@example.test']);
    expect(JSON.stringify(next.payload)).not.toContain('accepted@example.test');
  });

  it('does not reconcile another user or revision receipt as this delivery', async () => {
    const row = await enqueue(); const claim = await claimed(row.id); await queue.beginScheduledDispatch(claim);
    await query("UPDATE scheduled_mail SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [row.id]);
    for (const [owner, revision] of [[outsider, 1], [user, 2]] as const) {
      await query(`INSERT INTO send_idempotency(user_id,idempotency_key,request_fingerprint,status,intent_token,result)
        VALUES ($1,$2,$3,'completed',$4,$5)`, [owner, `scheduled:${row.id}:${revision}`, 'a'.repeat(64), randomUUID(), ok.body]);
    }
    await queue.recoverScheduledMail();
    expect(await stored(row.id)).toMatchObject({ state: 'uncertain', revision: 1 });
    expect(await queue.claimScheduledMail()).toBeNull();
    expect(await queue.renewScheduledClaim(claim)).toBe(false);
    expect(await queue.beginScheduledDispatch(claim)).toBe(false);
    const before = await stored(row.id); await queue.completeScheduledMail(claim, ok);
    expect(await stored(row.id)).toEqual(before);
  });

  it.each([
    { name: 'partial', result: { ok: true, partialDelivery: true, accepted: ['accepted@example.test'], rejected: ['private@example.test'] }, state: 'partial' },
    { name: 'overlapping evidence', result: { ok: true, partialDelivery: true, accepted: ['private@example.test'], rejected: ['PRIVATE@example.test'] }, state: 'uncertain' },
    { name: 'foreign recipient', result: { ok: true, rejected: ['unknown@example.test'] }, state: 'uncertain' },
    { name: 'malformed rejected list', result: { ok: true, rejected: [null] }, state: 'uncertain' },
    { name: 'missing recipient evidence', result: { ok: true, partialDelivery: true }, state: 'uncertain' },
  ])('observes $name durable receipts without resubmission', async ({ result, state }) => {
    const row = await enqueue(); const claim = await claimed(row.id); await queue.beginScheduledDispatch(claim);
    await query("UPDATE scheduled_mail SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [row.id]);
    await query(`INSERT INTO send_idempotency(user_id,idempotency_key,request_fingerprint,status,intent_token,result)
      VALUES ($1,$2,$3,'completed',$4,$5)`, [user, `scheduled:${row.id}:1`, 'a'.repeat(64), randomUUID(), result]);
    prepare.mockClear(); await queue.recoverScheduledMail(); await queue.recoverScheduledMail();
    const observed = await stored(row.id); expect(observed.state).toBe(state);
    if (state === 'partial') {
      expect(observed.payload).toEqual({ senderEmail: 'sender@example.test', payload: { ...message, to: [], cc: [], bcc: ['private@example.test'] } });
    } else {
      expect(observed.last_error_code).toBe('SEND_OUTCOME_UNKNOWN');
      await expect(queue.editScheduledMail(user, row.id, 1)).rejects.toMatchObject({ status: 409 });
    }
    expect(prepare).not.toHaveBeenCalled(); expect(await queue.claimScheduledMail()).toBeNull();
  });

  it('parks incomplete partial outcomes rather than offering every recipient for retry', async () => {
    const row = await enqueue(); const claim = await claimed(row.id); await queue.beginScheduledDispatch(claim);
    await queue.completeScheduledMail(claim, { status: 200, body: { ok: true, partialDelivery: true } });
    expect(await stored(row.id)).toMatchObject({ state: 'uncertain', last_error_code: 'SEND_OUTCOME_UNKNOWN' });
    expect(await queue.claimScheduledMail()).toBeNull();
  });

  it('dismisses only an owner-matched current uncertain outcome and purges private content with replayable receipts', async () => {
    const key = randomUUID(); const input = { scheduledAt: instant() };
    const row = await enqueue(key, input);
    const pending = await stored(row.id);
    await expect(queue.dismissScheduledMail(user, row.id, 1)).rejects.toMatchObject({ status: 409 });
    expect(await stored(row.id)).toEqual(pending);
    const claim = await claimed(row.id);
    const preparing = await stored(row.id);
    await expect(queue.dismissScheduledMail(user, row.id, 1)).rejects.toMatchObject({ status: 409 });
    expect(await stored(row.id)).toEqual(preparing);
    expect(await queue.beginScheduledDispatch(claim)).toBe(true);
    const sending = await stored(row.id);
    await expect(queue.dismissScheduledMail(user, row.id, 1)).rejects.toMatchObject({ status: 409 });
    expect(await stored(row.id)).toEqual(sending);
    await queue.completeScheduledMail(claim, { status: 503, body: { code: 'SEND_OUTCOME_UNKNOWN', rejected: ['private@example.test'] } });
    const uncertain = await stored(row.id);
    expect(uncertain.state).toBe('uncertain');
    expect(JSON.stringify(uncertain.payload)).toContain('private@example.test');
    expect(uncertain.result).toMatchObject({ rejected: ['private@example.test'] });
    for (const [actor, revision] of [[outsider, 1], [user, 2]] as const) {
      await expect(queue.dismissScheduledMail(actor, row.id, revision)).rejects.toMatchObject({ status: 409 });
      expect(await stored(row.id)).toEqual(uncertain);
    }
    await expect(queue.cancelScheduledMail(user, row.id, 1)).rejects.toMatchObject({ status: 409 });
    const receipt = await queue.dismissScheduledMail(user, row.id, 1);
    expect(receipt).toMatchObject({ id: row.id, state: 'dismissed', revision: 2, errorCode: null });
    const dismissed = await stored(row.id);
    expect(dismissed).toMatchObject({ payload: {}, result: null, revision: 2, state: 'dismissed', last_error_code: null });
    expect(JSON.stringify(dismissed)).not.toContain('private@example.test');
    expect(await queue.dismissScheduledMail(user, row.id, 1)).toEqual(receipt);
    expect(await stored(row.id)).toEqual(dismissed);
    await expect(queue.dismissScheduledMail(outsider, row.id, 1)).rejects.toMatchObject({ status: 409 });
    await expect(queue.dismissScheduledMail(user, row.id, 2)).rejects.toMatchObject({ status: 409 });
    expect(await enqueue(key, input)).toEqual(receipt);
    await expect(enqueue(key, { ...input, message: { ...message, bcc: ['changed@example.test'] } })).rejects.toMatchObject({ code: 'SCHEDULE_KEY_MISMATCH' });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect((await query('SELECT count(*)::int AS n FROM scheduled_mail')).rows[0].n).toBe(1);
    for (const revision of [1, 2]) {
      await expect(queue.editScheduledMail(user, row.id, revision)).rejects.toMatchObject({ status: 409 });
      await expect(queue.rescheduleMail(user, row.id, { revision, scheduledAt: instant(), timeZone: 'UTC' })).rejects.toMatchObject({ status: 409 });
      await expect(queue.updateScheduledMail(user, row.id, { revision, message, sendNow: true, timeZone: 'UTC' }, prepare)).rejects.toMatchObject({ status: 409 });
      await expect(queue.cancelScheduledMail(user, row.id, revision)).rejects.toMatchObject({ status: 409 });
    }
    expect(await queue.claimScheduledMail()).toBeNull();
    expect(await stored(row.id)).toEqual(dismissed);
  });

  it('frees exactly one of 100 active quota slots when an uncertain outcome is dismissed', async () => {
    const row = await enqueue(); const claim = await claimed(row.id);
    await queue.beginScheduledDispatch(claim);
    await queue.completeScheduledMail(claim, { status: 503, body: { code: 'SEND_OUTCOME_UNKNOWN' } });
    await query(`INSERT INTO scheduled_mail(id,user_id,account_id,idempotency_key,request_fingerprint,mode,scheduled_at,time_zone,payload)
      SELECT gen_random_uuid(),$1,$2,'fixture-'||n,repeat('a',64),'schedule',clock_timestamp()+interval '1 day','UTC','{}'::jsonb FROM generate_series(1,99) n`, [user, account]);
    await expect(enqueue()).rejects.toMatchObject({ code: 'SCHEDULE_QUEUE_FULL' });
    await queue.dismissScheduledMail(user, row.id, 1);
    expect(await enqueue()).toMatchObject({ state: 'pending', revision: 1 });
    await expect(enqueue()).rejects.toMatchObject({ code: 'SCHEDULE_QUEUE_FULL' });
    expect((await query('SELECT count(*)::int AS n FROM scheduled_mail')).rows[0].n).toBe(101);
  });

  it('never resurrects dismissed outcomes from late receipts or workers and lists only seven days of metadata', async () => {
    const row = await enqueue(); const claim = await claimed(row.id);
    await queue.beginScheduledDispatch(claim);
    await queue.completeScheduledMail(claim, { status: 503, body: { code: 'SEND_OUTCOME_UNKNOWN' } });
    const receipt = await queue.dismissScheduledMail(user, row.id, 1);
    const before = await stored(row.id);
    for (const revision of [1, 2]) {
      await query(`INSERT INTO send_idempotency(user_id,idempotency_key,request_fingerprint,status,intent_token,result)
        VALUES ($1,$2,$3,'completed',$4,$5)`, [user, `scheduled:${row.id}:${revision}`, 'a'.repeat(64), randomUUID(), ok.body]);
    }
    await queue.completeScheduledMail(claim, ok);
    await queue.releaseScheduledClaim(claim);
    expect(await queue.beginScheduledDispatch(claim)).toBe(false);
    expect(await queue.renewScheduledClaim(claim)).toBe(false);
    await queue.recoverScheduledMail(); await queue.recoverScheduledMail();
    expect(await stored(row.id)).toEqual(before);
    expect(await queue.claimScheduledMail()).toBeNull();
    expect(await queue.listScheduledMail(user)).toEqual([receipt]);
    expect(receipt).not.toHaveProperty('payload'); expect(receipt).not.toHaveProperty('result');
    expect(JSON.stringify(receipt)).not.toContain('private@example.test');
    expect(await queue.listScheduledMail(outsider)).toEqual([]);
    await query("UPDATE scheduled_mail SET updated_at=clock_timestamp()-interval '6 days 23 hours' WHERE id=$1", [row.id]);
    expect(await queue.listScheduledMail(user)).toHaveLength(1);
    await query("UPDATE scheduled_mail SET updated_at=clock_timestamp()-interval '7 days 1 second' WHERE id=$1", [row.id]);
    expect(await queue.listScheduledMail(user)).toEqual([]);
    expect(await queue.dismissScheduledMail(user, row.id, 1)).toEqual(receipt);
    expect(await stored(row.id)).toMatchObject({ state: 'dismissed', revision: 2, payload: {}, result: null });
  });

  it('fences recovery that read a completed receipt before dismissal won the update race', async () => {
    const row = await enqueue(); const claim = await claimed(row.id);
    await queue.beginScheduledDispatch(claim);
    await queue.completeScheduledMail(claim, { status: 503, body: { code: 'SEND_OUTCOME_UNKNOWN' } });
    await query(`INSERT INTO send_idempotency(user_id,idempotency_key,request_fingerprint,status,intent_token,result)
      VALUES ($1,$2,$3,'completed',$4,$5)`, [user, `scheduled:${row.id}:1`, 'a'.repeat(64), randomUUID(), ok.body]);
    let observed = false;
    await queue.recoverScheduledMail({
      /** Dismiss after the real receipt read, before recovery can apply its stale result. */
      async query<T>(sql: string, params?: unknown[]) {
        const result = await query<T>(sql, params);
        if (sql.includes('JOIN send_idempotency')) {
          expect(result.rows).toHaveLength(1);
          observed = true;
          await queue.dismissScheduledMail(user, row.id, 1);
        }
        return result;
      },
    });
    expect(observed).toBe(true);
    expect(await stored(row.id)).toMatchObject({ state: 'dismissed', revision: 2, payload: {}, result: null });
    expect(await queue.claimScheduledMail()).toBeNull();
  });

  it.each(['preparing', 'sending'])('releases proven undispatched %s work with a fresh revision and fences every old worker operation', async state => {
    const row = await enqueue(); const stale = await claimed(row.id);
    if (state === 'sending') expect(await queue.beginScheduledDispatch(stale)).toBe(true);
    const before = await stored(row.id);
    expect(before.state).toBe(state);
    await queue.releaseScheduledClaim({ ...stale, lease_token: randomUUID() });
    expect(await stored(row.id)).toEqual(before);
    await queue.releaseScheduledClaim(stale);
    expect(await stored(row.id)).toMatchObject({ state: 'pending', revision: 2,
      lease_token: null, lease_until: null, dispatch_started_at: null, payload: before.payload });
    const released = await stored(row.id);
    await queue.releaseScheduledClaim(stale);
    expect(await stored(row.id)).toEqual(released);
    const current = await queue.claimScheduledMail();
    expect(current).toMatchObject({ id: row.id, revision: 2, state: 'preparing' });
    expect(current?.lease_token).toEqual(expect.any(String));
    expect(current?.lease_token).not.toBe(stale.lease_token);
    if (!current) throw new Error('Expected fresh claim');
    const fresh = await stored(row.id);
    await queue.releaseScheduledClaim(stale);
    await queue.completeScheduledMail(stale, ok);
    expect(await queue.beginScheduledDispatch(stale)).toBe(false);
    expect(await queue.renewScheduledClaim(stale)).toBe(false);
    expect(await stored(row.id)).toEqual(fresh);
    expect(await queue.beginScheduledDispatch(current)).toBe(true);
    await queue.completeScheduledMail(current, ok);
    expect(await stored(row.id)).toMatchObject({ state: 'sent', revision: 2 });
  });

  it('cannot release an uncertain outcome even with a matching lease token', async () => {
    const row = await enqueue(); const claim = await claimed(row.id);
    await queue.beginScheduledDispatch(claim);
    await queue.completeScheduledMail(claim, { status: 503, body: { code: 'SEND_OUTCOME_UNKNOWN' } });
    // Retain the old token deliberately to prove state fencing independently of token fencing.
    await query('UPDATE scheduled_mail SET lease_token=$2 WHERE id=$1', [row.id, claim.lease_token]);
    const before = await stored(row.id);
    await queue.releaseScheduledClaim(claim);
    expect(await stored(row.id)).toEqual(before);
    expect(await queue.claimScheduledMail()).toBeNull();
  });

  it('acknowledges only owner-visible sent results without changing delivery state, revision or receipts', async () => {
    const row = await enqueue();
    const claimedRow = await claimed(row.id);
    await queue.completeScheduledMail(claimedRow, ok);
    const before = await stored(row.id);
    expect(before.payload).toEqual({});
    expect(before.sent_metadata).toEqual({ senderEmail: 'sender@example.test', to: message.to, cc: message.cc, recipientCount: 4 });
    expect(JSON.stringify(before.sent_metadata)).not.toContain('private@example.test');
    expect(await queue.listScheduledMail(user)).toHaveLength(1);
    expect((await stored(row.id)).sent_seen_at).toBeNull();
    await expect(queue.acknowledgeSentMail(outsider, row.id)).rejects.toMatchObject({ status: 404 });
    await expect(queue.acknowledgeSentMail(user, randomUUID())).rejects.toMatchObject({ status: 404 });
    await queue.acknowledgeSentMail(user, row.id);
    const seen = await stored(row.id);
    expect(seen.sent_seen_at).toBeInstanceOf(Date);
    for (const key of ['state', 'revision', 'payload', 'result', 'updated_at', 'request_fingerprint', 'idempotency_key']) {
      expect(seen[key]).toEqual(before[key]);
    }
    expect(await queue.listScheduledMail(user)).toEqual([]);
    await queue.acknowledgeSentMail(user, row.id);
    expect((await stored(row.id)).sent_seen_at).toEqual(seen.sent_seen_at);
    // An acknowledgement must not make the immutable enqueue receipt reusable.
    const replay = await queue.enqueueScheduledMail(user,
      { mode: 'schedule', timeZone: row.timeZone, scheduledAt: row.scheduledAt.toISOString(), message },
      String(before.idempotency_key), prepare);
    expect(replay.id).toBe(row.id); expect(prepare).toHaveBeenCalledTimes(1);
    expect((await query('SELECT id FROM scheduled_mail WHERE user_id=$1', [user])).rows).toHaveLength(1);
  });

  it('rejects viewed-status receipts for every non-sent state and leaves those entries unchanged', async () => {
    for (const state of ['pending', 'editing', 'preparing', 'sending', 'failed', 'partial', 'uncertain', 'cancelled', 'dismissed']) {
      const row = await enqueue();
      await query(`UPDATE scheduled_mail SET state=$2,
        lease_token=CASE WHEN $2 IN ('preparing','sending') THEN gen_random_uuid() ELSE NULL END,
        lease_until=CASE WHEN $2 IN ('preparing','sending') THEN clock_timestamp()+interval '1 minute' ELSE NULL END WHERE id=$1`, [row.id, state]);
      const before = await stored(row.id);
      await expect(queue.acknowledgeSentMail(user, row.id)).rejects.toMatchObject({ status: 404 });
      expect(await stored(row.id)).toEqual(before);
      expect((await queue.listScheduledMail(user)).some(item => item.id === row.id)).toBe(true);
    }
  });

  it('pages every old unseen sent result with exact microsecond cursors rather than a seven-day or 200-row cutoff', async () => {
    await query(`INSERT INTO scheduled_mail(id,user_id,account_id,idempotency_key,request_fingerprint,subject,mode,state,scheduled_at,time_zone,payload,updated_at)
      SELECT gen_random_uuid(),$1,$2,'old-'||n,repeat('a',64),'Old result '||n,'schedule','sent',
        '2020-01-01T00:00:00Z'::timestamptz + n * interval '1 microsecond','UTC','{}'::jsonb,
        clock_timestamp()-interval '30 days' FROM generate_series(1,425) n`, [user, account]);
    const expected = (await query<{ id: string }>('SELECT id FROM scheduled_mail WHERE user_id=$1 ORDER BY scheduled_at DESC,id DESC', [user])).rows.map(row => row.id);
    const ids: string[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
    do {
      const page = await queue.pageScheduledMail(user, cursor);
      expect(page.items.length).toBeLessThanOrEqual(200);
      ids.push(...page.items.map(row => row.id));
      cursor = page.nextCursor ?? undefined;
      if (cursor) { expect(cursors.has(cursor)).toBe(false); cursors.add(cursor); }
    } while (cursor);
    expect(ids).toEqual(expected); expect(new Set(ids).size).toBe(425); expect(cursors.size).toBe(2);
    expect((await query('SELECT id FROM scheduled_mail WHERE sent_seen_at IS NOT NULL')).rows).toEqual([]);
    await queue.acknowledgeSentMail(user, ids[0]);
    const nextVisit = await queue.pageScheduledMail(user);
    expect(nextVisit.items.some(row => row.id === ids[0])).toBe(false);
    expect(nextVisit.items[0].id).toBe(ids[1]);
    expect((await queue.pageScheduledMail(outsider)).items).toEqual([]);
    for (const invalid of ['!', '', 'e30', Buffer.from(JSON.stringify({ active: 1, at: '2020-02-31T00:00:00.000000Z', id: randomUUID() })).toString('base64url')]) {
      await expect(queue.pageScheduledMail(user, invalid)).rejects.toMatchObject({ status: 400 });
    }
  });

  it('previews frozen content and real reply ancestry without pausing, claiming or marking the queue result seen', async () => {
    const root = randomUUID(); const parent = randomUUID(); const unrelated = randomUUID();
    await query(`INSERT INTO messages(id,account_id,uid,folder,message_id,subject,from_email,date,in_reply_to,thread_references,body_text)
      VALUES ($1,$4,1,'INBOX','<root@example.test>','Same subject','sender@example.test','2025-01-01',NULL,NULL,'Root body'),
        ($2,$4,2,'INBOX','<parent@example.test>','Same subject','sender@example.test','2025-01-02','<root@example.test>','<root@example.test>','Parent body'),
        ($3,$4,3,'INBOX','<unrelated@example.test>','Same subject','sender@example.test','2025-01-03',NULL,NULL,'Not the thread')`,
    [root, parent, unrelated, account]);
    await query(`INSERT INTO messages(account_id,uid,folder,message_id,subject,date) VALUES ($1,1,'INBOX','<parent@example.test>','Foreign copy','2025-01-01')`, [otherAccount]);
    message = { ...message, sendKind: 'reply', replyToMessageId: parent, replyParentMessageId: '<parent@example.test>',
      replyParentAccountId: account, inReplyTo: '<parent@example.test>', references: '<root@example.test> <parent@example.test>',
      quotedBody: 'Frozen quotation', quotedBodyHtml: '<blockquote>Frozen quotation</blockquote>' };
    const row = await enqueue(); const before = await stored(row.id);
    const preview = await previewScheduledMail(user, row.id);
    expect(preview.context.map(source => source.id)).toEqual([root, parent]);
    expect(preview.contextMissing).toBe(false);
    expect(preview.message).toMatchObject({ body: message.body, inReplyTo: message.inReplyTo, references: message.references,
      quotedBody: message.quotedBody, editedSignature: message.editedSignature,
      attachments: [{ filename: 'bytes.bin', size: 3, contentType: 'application/octet-stream' }] });
    expect(JSON.stringify(preview)).not.toContain('AAH/');
    expect(await stored(row.id)).toEqual(before); expect(prepare).toHaveBeenCalledTimes(1);
    await expect(previewScheduledMail(outsider, row.id)).rejects.toMatchObject({ status: 404 });
    await due(row.id);
    // A preview leaves the message claimable at its due time.
    expect((await queue.claimScheduledMail())?.id).toBe(row.id);
  });

  it('keeps a reply preview usable when its source is gone and preserves reply identity through editing', async () => {
    message = { ...message, sendKind: 'reply', aliasId: randomUUID(), replyToMessageId: randomUUID(),
      replyParentAccountId: account, replyParentMessageId: '<missing@example.test>',
      inReplyTo: '<missing@example.test>', references: '<root@example.test> <missing@example.test>',
      quotedBody: 'Saved quotation', quotedBodyHtml: '<blockquote>Saved quotation</blockquote>' };
    const row = await enqueue();
    const preview = await previewScheduledMail(user, row.id);
    expect(preview.context).toEqual([]); expect(preview.contextMissing).toBe(true);
    expect(preview.message?.body).toBe(message.body);
    const edit = await queue.editScheduledMail(user, row.id, row.revision);
    expect(edit.payload.payload).toEqual(message);
    const saved = await queue.updateScheduledMail(user, row.id, { revision: edit.revision, message: edit.payload.payload,
      scheduledAt: instant(), timeZone: 'America/New_York' }, prepare);
    const reopened = await queue.editScheduledMail(user, row.id, saved.revision);
    expect(reopened.payload.payload).toEqual(message);
  });

  it('resolves a sent receipt only to a unique owned Sent copy without retaining another body or attachment payload', async () => {
    const copy = randomUUID(); const row = await enqueue();
    await query(`INSERT INTO folders(account_id,path,name,special_use) VALUES ($1,'Sent','Sent','\\Sent')`, [account]);
    await query(`INSERT INTO messages(id,account_id,uid,folder,message_id,subject,date,body_text,provider_message_id)
      VALUES ($1,$2,1,'Sent','<sent@example.test>','Sent copy','2025-01-01','Actual sent body','provider-sent')`, [copy, account]);
    const claimedRow = await claimed(row.id);
    await queue.completeScheduledMail(claimedRow, { status: 200, body: { ok: true, sentFolder: 'Sent',
      sentReference: { rfcMessageId: '<sent@example.test>', providerMessageId: 'provider-sent' } } });
    const preview = await previewScheduledMail(user, row.id);
    expect(preview.message).toBeNull(); expect(preview.sentCopy?.id).toBe(copy);
    expect((await stored(row.id)).payload).toEqual({});
    expect(JSON.stringify((await stored(row.id)).sent_metadata)).not.toContain('original body');
    await query(`INSERT INTO messages(account_id,uid,folder,message_id,subject,date) VALUES ($1,2,'Sent','<sent@example.test>','Ambiguous copy','2025-01-01')`, [account]);
    const ambiguous = await previewScheduledMail(user, row.id);
    expect(ambiguous.sentCopy).toBeNull(); expect(ambiguous.state).toBe('sent');
    await query('DELETE FROM messages WHERE account_id=$1', [account]);
    await query(`INSERT INTO messages(account_id,uid,folder,message_id,provider_message_id,date) VALUES ($1,3,'Sent','<sent@example.test>','provider-sent','2025-01-01')`, [otherAccount]);
    expect((await previewScheduledMail(user, row.id)).sentCopy).toBeNull();
  });

});
