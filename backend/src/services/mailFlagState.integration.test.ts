import { pluginRegistry } from '../plugins/registry.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool, withTransaction } from './db.js';
import { GOOGLE_GRANT_AUDIENCE, GOOGLE_ISSUER, storeOAuthGrant, upsertProviderConnection } from './providerAuthService.js';
import type { FetchLike } from './providerAuthService.js';
import { acquireRefreshLease } from './providerTokenService.js';
import {
  deferMailFlagReadback, drainMailFlagIntents, drainMailFlagReadbacks, enqueueMailFlagIntent, processMailFlagIntent,
} from './mailFlagState.js';
import type { MailFlagPorts } from './mailFlagState.js';
import type { ProviderAdapterOutcome } from './providerMutationService.js';
import { mailFlagResponse, pushProviderMessageFlags } from './providerMailFlagWrite.js';

const suite = process.env.DB_HOST && process.env.DB_NAME ? describe : describe.skip;
suite('durable mail flags (real PostgreSQL, synthetic provider)', () => {
  let userId: string;
  let accountId: string;
  let messageId: string;
  let extraUserId: string | undefined;
  const manager = () => ({
    setFlag: vi.fn(async () => { throw new Error('Unexpected IMAP dispatch'); }),
    _enqueueFlagPush: vi.fn(), _resolveFlagPush: vi.fn(), broadcast: vi.fn(),
  });
  const flags = async () => (await pool.query<{ is_read: boolean; is_starred: boolean }>(
    'SELECT is_read, is_starred FROM messages WHERE id = $1', [messageId],
  )).rows[0];
  const intent = async (flag = '\\Seen') => (await pool.query<{
    generation: string; value: boolean; status: string; lease_token: string | null; code: string | null;
  }>('SELECT * FROM mail_flag_intents WHERE message_id = $1 AND flag = $2', [messageId, flag])).rows[0];
  const enqueue = (value: boolean, flag = '\\Seen') => enqueueMailFlagIntent({ userId, accountId, messageId, flag, value });
  const due = async () => {
    await pool.query('UPDATE mail_flag_intents SET next_attempt_at = NOW() WHERE message_id = $1', [messageId]);
    await pool.query('UPDATE mail_flag_readbacks SET next_attempt_at = NOW() WHERE message_id = $1', [messageId]);
  };
  const seedGoogleGrant = async (expired = false) => {
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    vi.stubEnv('GOOGLE_CLIENT_ID', 'synthetic-client');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'synthetic-secret');
    return withTransaction(async client => {
      const connectionId = await upsertProviderConnection(client, {
        userId, provider: 'google', issuer: GOOGLE_ISSUER, subject: `synthetic-${userId}`,
      });
      await storeOAuthGrant(client, {
        connectionId, audience: GOOGLE_GRANT_AUDIENCE, accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh',
        expiresAt: new Date(Date.now() + (expired ? -1000 : 3600_000)),
        scopes: ['https://www.googleapis.com/auth/gmail.modify'], clientIdAtIssue: 'synthetic-client',
      });
      await client.query('UPDATE email_accounts SET provider_connection_id=$2 WHERE id=$1', [accountId, connectionId]);
      return connectionId;
    });
  };
  beforeEach(async () => {
    userId = randomUUID(); accountId = randomUUID(); messageId = randomUUID();
    await pool.query('INSERT INTO users(id, username) VALUES($1, $2)', [userId, `flag-state-${userId}`]);
    await pool.query(`INSERT INTO email_accounts(id, user_id, name, email_address, protocol, mail_transport)
      VALUES($1, $2, 'Synthetic flag mailbox', 'synthetic@example.test', 'imap', 'gmail_api')`, [accountId, userId]);
    await pool.query(`INSERT INTO folders(account_id, path, name, uid_validity, unread_count)
      VALUES($1, 'INBOX', 'Inbox', 7, 1)`, [accountId]);
    await pool.query(`INSERT INTO messages(id, account_id, uid, folder, provider_message_id, is_read, is_starred)
      VALUES($1, $2, 4, 'INBOX', 'synthetic-remote', false, false)`, [messageId, accountId]);
  });
  afterEach(async () => {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    if (extraUserId) await pool.query('DELETE FROM users WHERE id = $1', [extraUserId]);
    extraUserId = undefined;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function batchMessages(count: number) {
    const ids = [messageId];
    for (let uid = 5; ids.length < count; uid++) {
      const id = randomUUID(); ids.push(id);
      await pool.query(`INSERT INTO messages(id,account_id,uid,folder,provider_message_id,is_read,is_starred)
        VALUES($1,$2,$3,'INBOX',$1::uuid::text,false,false)`, [id,accountId,uid]);
    }
    return ids.map(id => ({ userId,accountId,messageId:id,flag:'\\Seen',value:true }));
  }
  it('commits every batch intent before its first provider write and recovers the deferred tail', async () => {
    const inputs=await batchMessages(7);
    const write=vi.fn<NonNullable<MailFlagPorts['write']>>(async () => {
      const durable=await pool.query('SELECT message_id FROM mail_flag_intents WHERE account_id=$1',[accountId]);
      expect(durable.rowCount).toBe(7);
      return {status:'committed'};
    });
    const response=mailFlagResponse(await pushProviderMessageFlags(inputs,{manager:manager(),write},{immediateLimit:2}));
    expect(response.updated).toHaveLength(2);
    expect(response.pending).toHaveLength(5);
    expect(write).toHaveBeenCalledTimes(2);
    await drainMailFlagIntents({manager:manager(),write},25,accountId);
    expect(write).toHaveBeenCalledTimes(7);
    expect((await pool.query('SELECT id FROM messages WHERE account_id=$1 AND is_read=true',[accountId])).rowCount).toBe(7);
  });
  it('rolls back the whole batch before dispatch when durable storage rejects one member', async () => {
    const inputs=await batchMessages(2);
    const name=`batch_failure_${randomUUID().replaceAll('-','')}`;
    const write=vi.fn<NonNullable<MailFlagPorts['write']>>(async () => ({status:'committed'}));
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.message_id='${inputs[1].messageId}'::uuid THEN RAISE EXCEPTION 'synthetic storage refusal'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON mail_flag_intents FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      await expect(pushProviderMessageFlags(inputs,{manager:manager(),write})).rejects.toThrow('synthetic storage refusal');
      expect(write).not.toHaveBeenCalled();
      expect((await pool.query('SELECT 1 FROM mail_flag_intents WHERE account_id=$1',[accountId])).rowCount).toBe(0);
      expect((await flags()).is_read).toBe(false);
    } finally {
      await pool.query(`DROP TRIGGER ${name} ON mail_flag_intents`);
      await pool.query(`DROP FUNCTION ${name}()`);
    }
  });
  it('serializes reversed concurrent batches without dropping members or generations', async () => {
    const inputs=await batchMessages(3);
    const write=vi.fn<NonNullable<MailFlagPorts['write']>>(async () => ({status:'committed'}));
    await Promise.all([
      pushProviderMessageFlags(inputs,{manager:manager(),write},{immediateLimit:0}),
      pushProviderMessageFlags([...inputs].reverse().map(input=>({...input,value:false})),{manager:manager(),write},{immediateLimit:0}),
    ]);
    expect(write).not.toHaveBeenCalled();
    const rows=(await pool.query<{generation:string;value:boolean}>('SELECT generation,value FROM mail_flag_intents WHERE account_id=$1',[accountId])).rows;
    expect(rows).toHaveLength(3);
    expect(rows.every(row=>row.generation==='2')).toBe(true);
    expect(new Set(rows.map(row=>row.value)).size).toBe(1);
  });
  it('updates Gmail flag labels after confirmation and readback without touching folder labels', async () => {
    await pool.query("UPDATE messages SET provider_labels=ARRAY['INBOX','Label_custom','UNREAD'] WHERE id=$1",[messageId]);
    await pool.query("INSERT INTO message_labels(message_id,account_id,label_id,folder_path) VALUES($1,$2,'UNREAD',NULL),($1,$2,'Label_custom','Work')",[messageId,accountId]);
    await enqueue(true);
    await processMailFlagIntent(messageId,'\\Seen',{manager:manager(),write:async()=>({status:'committed'})});
    expect((await pool.query('SELECT provider_labels FROM messages WHERE id=$1',[messageId])).rows[0].provider_labels).toEqual(['INBOX','Label_custom']);
    expect((await pool.query("SELECT 1 FROM message_labels WHERE message_id=$1 AND label_id='UNREAD'",[messageId])).rowCount).toBe(0);
    await pool.query("UPDATE messages SET read_changed_at=NOW()-interval '1 minute' WHERE id=$1",[messageId]);
    await deferMailFlagReadback(messageId); await due();
    await drainMailFlagReadbacks({manager:manager(),read:async()=>({isRead:false,isStarred:true})},25,accountId);
    expect(await flags()).toEqual({is_read:false,is_starred:true});
    expect(new Set((await pool.query('SELECT provider_labels FROM messages WHERE id=$1',[messageId])).rows[0].provider_labels)).toEqual(new Set(['INBOX','Label_custom','UNREAD','STARRED']));
    expect((await pool.query("SELECT folder_path FROM message_labels WHERE message_id=$1 AND label_id='Label_custom'",[messageId])).rows).toEqual([{folder_path:'Work'}]);
  });
  it('schedules exact sibling observations for queued writes without copying read state', async () => {
    const inputs=await batchMessages(3);
    await pool.query("UPDATE messages SET message_id='<same@example.test>' WHERE account_id=$1",[accountId]);
    const write=vi.fn<NonNullable<MailFlagPorts['write']>>(async()=>({status:'committed'}));
    await pushProviderMessageFlags(inputs,{manager:manager(),write},{immediateLimit:0});
    await Promise.all(inputs.map(input=>processMailFlagIntent(input.messageId,'\\Seen',{manager:manager(),write})));
    expect(write).toHaveBeenCalledTimes(3);
    expect((await pool.query('SELECT 1 FROM mail_flag_readbacks WHERE message_id=ANY($1::uuid[])',[inputs.map(input=>input.messageId)])).rowCount).toBe(3);
  });

  it('confirms an ordinary write, refreshes counts, and returns only actual successes', async () => {
    const port = manager();
    const write = vi.fn<NonNullable<MailFlagPorts['write']>>(async () => ({ status: 'committed' }));
    await enqueue(true);
    const result = await processMailFlagIntent(messageId, '\\Seen', { manager: port, write });
    expect(result).toEqual({ status: 'confirmed' });
    expect(await flags()).toEqual({ is_read: true, is_starred: false });
    expect((await intent()).status).toBe('confirmed');
    expect((await pool.query<{ unread_count: number }>('SELECT unread_count FROM folders WHERE account_id = $1', [accountId])).rows[0]!.unread_count).toBe(0);
    expect(port.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'message_flags' }), userId);
    expect(mailFlagResponse([
      { id: 'confirmed', ...result }, { id: 'waiting', status: 'retryable' },
      { id: 'unknown', status: 'outcome_unknown' }, { id: 'denied', status: 'permanent', code: 'PROVIDER_AUTH_REQUIRED' },
    ])).toMatchObject({ ok: true, updated: ['confirmed'], pending: ['waiting', 'unknown'], failed: ['denied'] });
  });

  for (const oldOutcome of ['committed', 'permanent'] as const) {
    it(`preserves a newer failed toggle after older in-flight ${oldOutcome}`, async () => {
      let release!: (outcome: ProviderAdapterOutcome<void>) => void;
      let started!: () => void;
      const dispatched = new Promise<void>(resolve => { started = resolve; });
      const waiting = new Promise<ProviderAdapterOutcome<void>>(resolve => { release = resolve; });
      await enqueue(true);
      const first = processMailFlagIntent(messageId, '\\Seen', {
        manager: manager(), write: async () => { started(); return waiting; },
      });
      await dispatched;
      await enqueue(false);
      const blockedWrite = vi.fn<NonNullable<MailFlagPorts['write']>>(async () => ({ status: 'committed' }));
      expect(await processMailFlagIntent(messageId, '\\Seen', { manager: manager(), write: blockedWrite })).toEqual({ status: 'pending' });
      expect(blockedWrite).not.toHaveBeenCalled();
      release(oldOutcome === 'committed' ? { status: 'committed' } : { status: 'permanent', code: 'PROVIDER_AUTH_REQUIRED' });
      await first;
      expect(await intent()).toMatchObject({ generation: '2', value: false, status: 'pending', lease_token: null });
      expect((await flags()).is_read).toBe(false);
      const second = await processMailFlagIntent(messageId, '\\Seen', {
        manager: manager(), write: async () => ({ status: 'permanent', code: 'PROVIDER_AUTH_REQUIRED' }),
      });
      expect(second).toEqual({ status: 'permanent', code: 'PROVIDER_AUTH_REQUIRED' });
      expect(await intent()).toMatchObject({ generation: '2', value: false, status: 'failed' });
      expect((await flags()).is_read).toBe(false);
    });
  }

  for (const landed of [false, true]) {
    it(`reads provider truth after an unknown write that ${landed ? 'landed' : 'did not land'}, preserving later remote edit`, async () => {
      let remoteRead = false;
      await enqueue(true);
      const write = vi.fn<NonNullable<MailFlagPorts['write']>>(async () => {
        remoteRead = landed;
        return { status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' };
      });
      await processMailFlagIntent(messageId, '\\Seen', { manager: manager(), write });
      expect((await intent()).status).toBe('readback');
      // A later external edit is authoritative regardless of whether the first
      // unknown write landed. Recreate all worker ports to model restart.
      remoteRead = false;
      const replay = vi.fn<NonNullable<MailFlagPorts['write']>>(async () => ({ status: 'committed' }));
      const read = vi.fn(async () => ({ isRead: remoteRead, isStarred: true }));
      await due();
      const result = await processMailFlagIntent(messageId, '\\Seen', { manager: manager(), write: replay, read });
      expect(result).toEqual({ status: 'outcome_unknown', code: 'RECONCILED_PROVIDER_STATE' });
      expect(replay).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledOnce();
      expect(await intent()).toMatchObject({ status: 'reconciled' });
      expect((await flags()).is_read).toBe(false);
    });
  }

  it('reasserts a same-state click as a fresh intent after unresolved write', async () => {
    await enqueue(false);
    await processMailFlagIntent(messageId, '\\Seen', {
      manager: manager(), write: async () => ({ status: 'outcome_unknown' }),
    });
    await enqueue(false);
    const write = vi.fn<NonNullable<MailFlagPorts['write']>>(async () => ({ status: 'committed' }));
    expect(await processMailFlagIntent(messageId, '\\Seen', { manager: manager(), write })).toEqual({ status: 'confirmed' });
    expect(write).toHaveBeenCalledOnce();
    expect(await intent()).toMatchObject({ generation: '2', value: false, status: 'confirmed' });
  });

  it('does not acknowledge a newer intent as success for an older request that had not dispatched yet', async () => {
    const older = await enqueue(true);
    const newer = await enqueue(false);
    if (!older || !newer) throw new Error('Expected both synthetic intents');
    const write = vi.fn<NonNullable<MailFlagPorts['write']>>(async () => ({ status: 'committed' }));
    const ports = { manager: manager(), write };
    expect((await processMailFlagIntent(messageId, '\\Seen', ports, older.generation)).status).toBe('pending');
    expect(write).not.toHaveBeenCalled();
    expect(await intent()).toMatchObject({ generation: newer.generation, value: false, status: 'pending', lease_token: null });
    expect(await processMailFlagIntent(messageId, '\\Seen', ports, newer.generation)).toEqual({ status: 'confirmed' });
    expect(write).toHaveBeenCalledOnce();
  });

  it('drains retryable Gmail intent after restart with no persistent mailbox connection', async () => {
    await enqueue(true, '\\Flagged');
    expect(await processMailFlagIntent(messageId, '\\Flagged', {
      manager: manager(), write: async () => ({ status: 'retryable', code: 'UPSTREAM_UNAVAILABLE' }),
    })).toEqual({ status: 'retryable', code: 'UPSTREAM_UNAVAILABLE' });
    expect((await intent('\\Flagged')).status).toBe('pending');
    expect((await flags()).is_starred).toBe(false);
    await due();
    // Fresh worker ports have no connected clients or memory of the first attempt.
    const freshManager = manager();
    const write = vi.fn<NonNullable<MailFlagPorts['write']>>(async () => ({ status: 'committed' }));
    await drainMailFlagIntents({ manager: freshManager, write }, 25, accountId);
    expect(write).toHaveBeenCalledOnce();
    expect(freshManager.setFlag).not.toHaveBeenCalled();
    expect((await intent('\\Flagged')).status).toBe('confirmed');
    expect((await flags()).is_starred).toBe(true);
  });

  it('recovers a pending intent across two separate worker processes', async () => {
    await enqueue(true);
    const script = `
      import { processMailFlagIntent, drainMailFlagIntents } from './src/services/mailFlagState.ts';
      import { pool } from './src/services/db.ts';
      const [mode, accountId, messageId] = process.argv.slice(1);
      const manager = {
        async setFlag() { throw new Error('Unexpected synthetic IMAP dispatch'); },
        _enqueueFlagPush() {}, _resolveFlagPush() {}
      };
      let writes = 0;
      const ports = { manager, write: async () => {
        writes++;
        return mode === 'initial' ? { status: 'retryable', code: 'UPSTREAM_UNAVAILABLE' } : { status: 'committed' };
      }};
      try {
        if (mode === 'initial') await processMailFlagIntent(messageId, '\\\\Seen', ports);
        else await drainMailFlagIntents(ports, 25, accountId);
        process.stdout.write(JSON.stringify({ writes }));
      } finally { await pool.end(); }
    `;
    const run = (mode: string) => promisify(execFile)(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval', script, '--', mode, accountId, messageId,
    ], { cwd: process.cwd(), timeout: 30_000 });
    expect(JSON.parse((await run('initial')).stdout)).toEqual({ writes: 1 });
    expect((await intent()).status).toBe('pending');
    expect((await flags()).is_read).toBe(false);
    await due();
    expect(JSON.parse((await run('restarted')).stdout)).toEqual({ writes: 1 });
    expect((await intent()).status).toBe('confirmed');
    expect((await flags()).is_read).toBe(true);
  }, 60_000);

  it('drains actual Gmail adapter after a real refresh lease prevents initial dispatch', async () => {
    const connectionId = await seedGoogleGrant(true);
    const grantId = (await pool.query<{ id: string }>('SELECT id FROM oauth_grants WHERE connection_id=$1', [connectionId])).rows[0]!.id;
    expect(await withTransaction(client => acquireRefreshLease(client, { grantId, owner: 'synthetic-refresh-worker' }))).not.toBeNull();
    const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
      expect(String(url)).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/synthetic-remote/modify');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ addLabelIds: [], removeLabelIds: ['UNREAD'] });
      return Response.json({ id: 'synthetic-remote', labelIds: ['INBOX'] });
    });
    vi.stubGlobal('fetch', fetchImpl);
    await enqueue(true);
    expect(await processMailFlagIntent(messageId, '\\Seen', { manager: manager() }))
      .toEqual({ status: 'retryable', code: 'UPSTREAM_UNAVAILABLE' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await flags()).is_read).toBe(false);
    await pool.query(`UPDATE oauth_grants SET expires_at=NOW()+INTERVAL '1 hour',refresh_lease_expires_at=NULL,refresh_lease_owner=NULL
      WHERE id=$1`, [grantId]);
    await due();
    const freshManager = manager();
    await drainMailFlagIntents({ manager: freshManager }, 25, accountId);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(freshManager.setFlag).not.toHaveBeenCalled();
    expect((await intent()).status).toBe('confirmed');
    expect((await flags()).is_read).toBe(true);
  });

  it('uses actual Gmail GET to reconcile a landed unknown write after a later remote edit', async () => {
    await seedGoogleGrant();
    let remoteRead = false;
    const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
      if (init?.method === 'POST') {
        remoteRead = true;
        throw new Error('Synthetic response lost after Gmail applied the flag');
      }
      expect(new URL(String(url)).searchParams.get('format')).toBe('minimal');
      return Response.json({ id: 'synthetic-remote', labelIds: remoteRead ? ['INBOX'] : ['INBOX', 'UNREAD'] });
    });
    vi.stubGlobal('fetch', fetchImpl);
    await enqueue(true);
    expect(await processMailFlagIntent(messageId, '\\Seen', { manager: manager() }))
      .toEqual({ status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' });
    expect(remoteRead).toBe(true);
    remoteRead = false;
    await due();
    await drainMailFlagIntents({ manager: manager() }, 25, accountId);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect((await intent()).status).toBe('reconciled');
    expect((await flags()).is_read).toBe(false);
  });

  it('does not accept a provider response after the intent lease expires', async () => {
    await enqueue(true);
    const result = await processMailFlagIntent(messageId, '\\Seen', {
      manager: manager(), write: async () => {
        await pool.query("UPDATE mail_flag_intents SET lease_until=NOW()-INTERVAL '1 second' WHERE message_id=$1", [messageId]);
        return { status: 'committed' };
      },
    });
    expect(result.status).not.toBe('confirmed');
    expect((await flags()).is_read).toBe(false);
    expect((await intent()).status).toBe('writing');
    const write = vi.fn<NonNullable<MailFlagPorts['write']>>(async () => ({ status: 'committed' }));
    await processMailFlagIntent(messageId, '\\Seen', {
      manager: manager(), write, read: async () => ({ isRead: true, isStarred: false }),
    });
    expect(write).not.toHaveBeenCalled();
    expect((await flags()).is_read).toBe(true);
    expect((await intent()).status).toBe('reconciled');
  });

  it('cannot apply an in-flight completion to a message rehomed under another tenant', async () => {
    extraUserId = randomUUID();
    const otherAccountId = randomUUID();
    await pool.query('INSERT INTO users(id, username) VALUES($1, $2)', [extraUserId, `flag-state-other-${extraUserId}`]);
    await pool.query(`INSERT INTO email_accounts(id, user_id, name, email_address, protocol, mail_transport)
      VALUES($1, $2, 'Other synthetic account', 'other@example.test', 'imap', 'gmail_api')`, [otherAccountId, extraUserId]);
    await pool.query("INSERT INTO folders(account_id, path, name, uid_validity) VALUES($1, 'INBOX', 'Inbox', 7)", [otherAccountId]);
    await enqueue(true);
    const result = await processMailFlagIntent(messageId, '\\Seen', {
      manager: manager(), write: async () => {
        await pool.query('UPDATE messages SET account_id=$2 WHERE id=$1', [messageId, otherAccountId]);
        return { status: 'committed' };
      },
    });
    expect(result).toEqual({ status: 'permanent', code: 'MAIL_IDENTITY_CHANGED' });
    expect((await flags()).is_read).toBe(false);
    expect((await intent()).status).toBe('failed');
  });

  it('reconciles an expired writing lease after restart without replay', async () => {
    await enqueue(true);
    await pool.query(`UPDATE mail_flag_intents SET status='writing', lease_token=$2, lease_until=NOW()-INTERVAL '1 second'
      WHERE message_id=$1`, [messageId, randomUUID()]);
    const write = vi.fn<NonNullable<MailFlagPorts['write']>>(async () => ({ status: 'committed' }));
    const read = vi.fn(async () => ({ isRead: false, isStarred: false }));
    await processMailFlagIntent(messageId, '\\Seen', { manager: manager(), write, read });
    expect(write).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
    expect((await intent()).status).toBe('reconciled');
    expect((await flags()).is_read).toBe(false);
  });

  for (const identity of ['transport generation', 'provider ID', 'UIDVALIDITY', 'UID'] as const) {
    it(`refuses dispatch after ${identity} changes`, async () => {
      await enqueue(true);
      if (identity === 'transport generation') await pool.query('UPDATE email_accounts SET transport_generation=transport_generation+1 WHERE id=$1', [accountId]);
      if (identity === 'provider ID') await pool.query("UPDATE messages SET provider_message_id='replacement' WHERE id=$1", [messageId]);
      if (identity === 'UIDVALIDITY') await pool.query('UPDATE folders SET uid_validity=8 WHERE account_id=$1', [accountId]);
      if (identity === 'UID') await pool.query('UPDATE messages SET uid=99 WHERE id=$1', [messageId]);
      const write = vi.fn<NonNullable<MailFlagPorts['write']>>(async () => ({ status: 'committed' }));
      expect(await processMailFlagIntent(messageId, '\\Seen', { manager: manager(), write }))
        .toEqual({ status: 'permanent', code: 'MAIL_IDENTITY_CHANGED' });
      expect(write).not.toHaveBeenCalled();
      expect((await flags()).is_read).toBe(false);
    });
  }

  it('rejects an intent from another tenant before persisting it', async () => {
    expect(await enqueueMailFlagIntent({ userId: randomUUID(), accountId, messageId, flag: '\\Seen', value: true })).toBeNull();
    expect(await intent()).toBeUndefined();
  });

  it('reconciles unread counts for every affected Gmail label', async () => {
    await pool.query("INSERT INTO folders(account_id,path,name,unread_count) VALUES($1,'Work','Work',1),($1,'Other','Other',9)",[accountId]);
    await pool.query("INSERT INTO message_labels(message_id,account_id,label_id,folder_path) VALUES($1,$2,'Label_Work','Work')",[messageId,accountId]);
    await deferMailFlagReadback(messageId);
    await due();
    await drainMailFlagReadbacks({manager:manager(),read:async()=>({isRead:true,isStarred:false})},25,accountId);
    const folders = (await pool.query<{path:string;unread_count:number}>('SELECT path,unread_count FROM folders WHERE account_id=$1 ORDER BY path',[accountId])).rows;
    expect(folders).toEqual([{path:'INBOX',unread_count:0},{path:'Other',unread_count:9},{path:'Work',unread_count:0}]);
  });

  it('honors provider throttling before another durable write attempt', async () => {
    await enqueue(true);
    const before = Date.now();
    await processMailFlagIntent(messageId, '\\Seen', { manager:manager(), write:async()=>({status:'retryable',code:'RATE_LIMITED',retryAfterSeconds:120}) });
    const next = (await pool.query<{next_attempt_at:Date}>('SELECT next_attempt_at FROM mail_flag_intents WHERE message_id=$1',[messageId])).rows[0]!;
    expect(next.next_attempt_at.getTime()).toBeGreaterThanOrEqual(before+120000);
  });

  it('invalidates plugin sections after background flag reconciliation', async () => {
    await deferMailFlagReadback(messageId);
    await due();
    const facade = { broadcast: vi.fn() };
    const hook = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue([]);
    try {
      await drainMailFlagReadbacks({ manager: { ...manager(), pluginFacade: facade }, read: async () => ({isRead:true,isStarred:true}) },25,accountId);
      expect(hook).toHaveBeenCalledWith('sectionsChanged', {mgr:facade, account:expect.objectContaining({id:accountId,user_id:userId}),changedCount:1});
    } finally { hook.mockRestore(); }
  });

  it('retains a protected readback obligation, then drains it with no new delta after restart', async () => {
    await pool.query('UPDATE messages SET is_read=true, is_starred=true, read_changed_at=NOW(), star_changed_at=NOW() WHERE id=$1', [messageId]);
    await deferMailFlagReadback(messageId);
    await due();
    const read = vi.fn(async () => ({ isRead: false, isStarred: false }));
    await drainMailFlagReadbacks({ manager: manager(), read }, 25, accountId);
    expect(await flags()).toEqual({ is_read: true, is_starred: true });
    expect((await pool.query('SELECT * FROM mail_flag_readbacks WHERE message_id=$1', [messageId])).rows).toHaveLength(1);
    await pool.query("UPDATE messages SET read_changed_at=NOW()-INTERVAL '1 minute', star_changed_at=NOW()-INTERVAL '1 minute' WHERE id=$1", [messageId]);
    await due();
    await drainMailFlagReadbacks({ manager: manager(), read }, 25, accountId);
    expect(await flags()).toEqual({ is_read: false, is_starred: false });
    expect((await pool.query('SELECT * FROM mail_flag_readbacks WHERE message_id=$1', [messageId])).rows).toHaveLength(0);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('preserves an observation obligation replaced while readback was in flight', async () => {
    await deferMailFlagReadback(messageId);
    await due();
    await drainMailFlagReadbacks({
      manager: manager(), read: async () => {
        await deferMailFlagReadback(messageId);
        return { isRead: true, isStarred: true };
      },
    }, 25, accountId);
    expect(await flags()).toEqual({ is_read: false, is_starred: false });
    expect((await pool.query<{ generation: string }>('SELECT generation FROM mail_flag_readbacks WHERE message_id=$1', [messageId])).rows[0]!.generation).toBe('2');
    await due();
    await drainMailFlagReadbacks({ manager: manager(), read: async () => ({ isRead: true, isStarred: true }) }, 25, accountId);
    expect(await flags()).toEqual({ is_read: true, is_starred: true });
    expect((await pool.query('SELECT * FROM mail_flag_readbacks WHERE message_id=$1', [messageId])).rows).toHaveLength(0);
  });

  for (const identity of ['UIDVALIDITY', 'provider ID'] as const) {
    it(`discards an obsolete observation before provider read when ${identity} changed since deferral`, async () => {
      await deferMailFlagReadback(messageId);
      if (identity === 'UIDVALIDITY') await pool.query('UPDATE folders SET uid_validity=8 WHERE account_id=$1', [accountId]);
      else await pool.query("UPDATE messages SET provider_message_id='replacement' WHERE id=$1", [messageId]);
      await due();
      const read = vi.fn(async () => ({ isRead: true, isStarred: true }));
      await drainMailFlagReadbacks({ manager: manager(), read }, 25, accountId);
      expect(read).not.toHaveBeenCalled();
      expect(await flags()).toEqual({ is_read: false, is_starred: false });
      expect((await pool.query('SELECT * FROM mail_flag_readbacks WHERE message_id=$1', [messageId])).rows).toHaveLength(0);
    });
  }

  it('heals a legacy observation with no intent payload by reading current state only', async () => {
    await pool.query('INSERT INTO mail_flag_readbacks(message_id) VALUES($1)', [messageId]);
    const read = vi.fn(async () => ({ isRead: false, isStarred: false }));
    const write = vi.fn<NonNullable<MailFlagPorts['write']>>(async () => ({ status: 'committed' }));
    await drainMailFlagReadbacks({ manager: manager(), read, write }, 25, accountId);
    expect(read).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    expect(await flags()).toEqual({ is_read: false, is_starred: false });
    expect((await pool.query('SELECT * FROM mail_flag_readbacks WHERE message_id=$1', [messageId])).rows).toHaveLength(0);
  });

  it('does not apply a readback response after its observation lease expires', async () => {
    await deferMailFlagReadback(messageId);
    await due();
    await drainMailFlagReadbacks({
      manager: manager(), read: async () => {
        await pool.query("UPDATE mail_flag_readbacks SET lease_until=NOW()-INTERVAL '1 second' WHERE message_id=$1", [messageId]);
        return { isRead: true, isStarred: true };
      },
    }, 25, accountId);
    expect(await flags()).toEqual({ is_read: false, is_starred: false });
    expect((await pool.query('SELECT * FROM mail_flag_readbacks WHERE message_id=$1', [messageId])).rows).toHaveLength(1);
  });

  it('does not overwrite a newer user intent that arrives during provider readback', async () => {
    await pool.query("UPDATE messages SET is_read=true, read_changed_at=NOW()-INTERVAL '1 minute' WHERE id=$1", [messageId]);
    await deferMailFlagReadback(messageId);
    await due();
    await drainMailFlagReadbacks({
      manager: manager(), read: async () => {
        await enqueue(true);
        return { isRead: false, isStarred: true };
      },
    }, 25, accountId);
    expect(await flags()).toEqual({ is_read: true, is_starred: true });
    expect(await intent()).toMatchObject({ status: 'pending', value: true });
    expect((await pool.query('SELECT * FROM mail_flag_readbacks WHERE message_id=$1', [messageId])).rows).toHaveLength(1);
  });

  it('records flag reconciliation honestly and does not complete unknown move/send journal entries', async () => {
    extraUserId = randomUUID();
    await pool.query('INSERT INTO users(id, username) VALUES($1, $2)', [extraUserId, `flag-state-foreign-${extraUserId}`]);
    await pool.query(`INSERT INTO provider_operations(user_id,resource_type,resource_id,operation,payload,status)
      VALUES($1,'message',$2,'update',$3::jsonb,'outcome_unknown')`,
    [extraUserId, messageId, JSON.stringify({ flag: '\\Seen', value: true })]);
    const entries = [
      { key: 'flag', operation: 'update', payload: { providerMessageId: 'synthetic-remote', flag: '\\Seen', value: true } },
      { key: 'different-remote', operation: 'update', payload: { providerMessageId: 'other-remote', flag: '\\Seen', value: true } },
      { key: 'unbound-native-flag', operation: 'update', payload: { flag: '\\Seen', value: true } },
      { key: 'move', operation: 'update', payload: { destinationFolderId: 'other' } },
      { key: 'send', operation: 'send', payload: {} },
      { key: 'legacy-imap', operation: 'update', payload: null },
    ];
    for (const entry of entries) await pool.query(`
      INSERT INTO provider_operations(user_id,account_id,resource_type,resource_id,operation,idempotency_key,payload,status)
      VALUES($1,$2,'message',$3,$4,$5,$6::jsonb,'outcome_unknown')`,
    [userId, accountId, messageId, entry.operation, entry.key, JSON.stringify(entry.payload)]);
    await deferMailFlagReadback(messageId);
    await due();
    const write = vi.fn<NonNullable<MailFlagPorts['write']>>(async () => ({ status: 'committed' }));
    await drainMailFlagReadbacks({ manager: manager(), write, read: async () => ({ isRead: false, isStarred: true }) }, 25, accountId);
    expect(write).not.toHaveBeenCalled();
    expect(await flags()).toEqual({ is_read: false, is_starred: true });
    const rows = (await pool.query<{ idempotency_key: string; status: string; error_code: string | null; result: unknown }>(
      'SELECT idempotency_key,status,error_code,result FROM provider_operations WHERE user_id=$1 ORDER BY idempotency_key', [userId],
    )).rows;
    expect(rows.find(row => row.idempotency_key === 'flag')).toMatchObject({
      status: 'cancelled', error_code: 'RECONCILED_PROVIDER_STATE', result: { reconciled: true, historicalOutcome: 'unknown' },
    });
    for (const key of ['move', 'send', 'legacy-imap', 'different-remote', 'unbound-native-flag']) expect(rows.find(row => row.idempotency_key === key)?.status).toBe('outcome_unknown');
    const foreign = (await pool.query<{ status: string }>('SELECT status FROM provider_operations WHERE user_id=$1', [extraUserId])).rows;
    expect(foreign).toEqual([{ status: 'outcome_unknown' }]);
  });

  it('imports a legacy native flag journaled after migration and reconciles without replaying it', async () => {
    await pool.query(`INSERT INTO provider_operations(user_id,account_id,resource_type,resource_id,operation,payload,status)
      VALUES($1,$2,'message',$3,'update',$4::jsonb,'outcome_unknown')`,
    [userId, accountId, messageId, JSON.stringify({ providerMessageId: 'synthetic-remote', flag: '\\Seen', value: true })]);
    const write = vi.fn<NonNullable<MailFlagPorts['write']>>(async () => ({ status: 'committed' }));
    const read = vi.fn(async () => ({ isRead: false, isStarred: true }));
    await drainMailFlagIntents({ manager: manager(), write, read }, 25, accountId);
    expect(write).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
    expect(await flags()).toEqual({ is_read: false, is_starred: true });
    const rows = (await pool.query<{ status: string; error_code: string; result: unknown }>(
      'SELECT status,error_code,result FROM provider_operations WHERE user_id=$1', [userId],
    )).rows;
    expect(rows).toEqual([{
      status: 'cancelled', error_code: 'RECONCILED_PROVIDER_STATE', result: { reconciled: true, historicalOutcome: 'unknown' },
    }]);
    expect((await pool.query('SELECT * FROM mail_flag_readbacks WHERE message_id=$1', [messageId])).rows).toHaveLength(0);
  });
  for (const malformed of [{}, { id: 'wrong-resource', labelIds: ['INBOX'] }, { id: 'synthetic-remote', labelIds: null }]) {
    it(`retains an unknown Gmail intent after invalid readback ${JSON.stringify(malformed)}`, async () => {
      await seedGoogleGrant();
      await enqueue(true);
      await processMailFlagIntent(messageId, '\\Seen', { manager: manager(), write: async () => ({ status: 'outcome_unknown' }) });
      await due();
      const fetch = vi.fn<FetchLike>(async () => Response.json(malformed));
      vi.stubGlobal('fetch', fetch);
      const outcome = await processMailFlagIntent(messageId, '\\Seen', { manager: manager() });
      expect(outcome.status).toBe('outcome_unknown');
      expect(fetch).toHaveBeenCalledOnce();
      expect((await flags()).is_read).toBe(false);
      expect((await intent()).status).toBe('readback');
    });
  }

  it('does not apply a late provider acknowledgement after the account is disabled', async () => {
    let release!: (value: ProviderAdapterOutcome<void>) => void;
    const response = new Promise<ProviderAdapterOutcome<void>>(resolve => { release = resolve; });
    let started!: () => void;
    const dispatched = new Promise<void>(resolve => { started = resolve; });
    await enqueue(true);
    const port = manager();
    const work = processMailFlagIntent(messageId, '\\Seen', { manager: port, write: () => { started(); return response; } });
    await dispatched;
    await pool.query('UPDATE email_accounts SET enabled=false WHERE id=$1', [accountId]);
    release({ status: 'committed' });
    expect((await work).status).toBe('permanent');
    expect((await flags()).is_read).toBe(false);
    expect(port.broadcast).not.toHaveBeenCalled();
    expect(await enqueue(true)).toBeNull();
  });

  it('resolves only a verified current Graph legacy alias to its canonical physical intent', async () => {
    const connectionId = randomUUID();
    const legacyId = randomUUID();
    await pool.query(`INSERT INTO provider_connections(id,user_id,provider,issuer,subject) VALUES($1,$2,'microsoft','synthetic-graph',$3)`, [connectionId, userId, connectionId]);
    await pool.query(`UPDATE email_accounts SET mail_transport='microsoft_graph',provider_connection_id=$2 WHERE id=$1`, [accountId, connectionId]);
    await pool.query(`INSERT INTO messages(id,account_id,uid,folder,subject,is_read) VALUES($1,$2,5,'INBOX','Synthetic alias',false)`, [legacyId, accountId]);
    expect(await enqueueMailFlagIntent({userId,accountId,messageId:legacyId,flag:'\\Seen',value:true})).toBeNull();
    await pool.query(`INSERT INTO graph_legacy_message_bindings(legacy_message_id,canonical_message_id,account_id,connection_id,status)
      VALUES($1,$2,$3,$4,'bound')`, [legacyId,messageId,accountId,connectionId]);
    const resolved = await enqueueMailFlagIntent({userId,accountId,messageId:legacyId,flag:'\\Seen',value:true});
    expect(resolved?.message_id).toBe(messageId);
    const write = vi.fn<NonNullable<MailFlagPorts['write']>>(async state => {
      expect(state.id).toBe(messageId);
      expect(state.identity.providerId).toBe('synthetic-remote');
      return { status: 'committed' };
    });
    await processMailFlagIntent(messageId, '\\Seen', { manager:manager(), write });
    expect(write).toHaveBeenCalledOnce();
    expect((await flags()).is_read).toBe(true);
    expect((await pool.query('SELECT * FROM mail_flag_intents WHERE message_id=$1',[legacyId])).rows).toHaveLength(0);
  });

});
