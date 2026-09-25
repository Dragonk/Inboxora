import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pool, withTransaction } from './db.js';
import { isCalendarCollectionDeleted, lockCalendarCollection, recordCalendarDeletionFence } from './calendarCollectionFence.js';
import { ensureGoogleCalendarCollection, syncGoogleCalendar } from './providers/google/googleCalendarSync.js';
import { ensureGraphCalendarCollection, syncGraphCalendar } from './providers/microsoft/graphCalendarSync.js';
import type { PoolClient } from 'pg';

vi.mock('./providerTokenService.js', () => ({
  getGoogleAccessToken: async () => ({ accessToken: 'test-token' }),
  getMicrosoftAccessToken: async () => ({ accessToken: 'test-token' }),
}));
vi.mock('./providerFeatureAuthorization.js', async original => {
  const actual = await original<typeof import('./providerFeatureAuthorization.js')>();
  return { ...actual, readProviderFeatureAuthorization: async () => actual.evaluateProviderFeatureAuthorization('google', 'calendar', ['calendar.calendarlist.readonly', 'calendar.events']) };
});

const suite = process.env.DB_HOST && process.env.DB_NAME ? describe : describe.skip;
const users: string[] = [];
const config = { clientId: 'test', clientSecret: 'test', redirectUri: 'https://example.test/cb', providerRedirectUri: 'https://example.test/provider-cb', tenantId: 'common' };
type Provider = 'google' | 'microsoft';
async function fixture(provider: Provider) {
  const userId = randomUUID(); users.push(userId);
  const connectionId = randomUUID(); const accountId = randomUUID(); const remoteCalendarId = `remote-${randomUUID()}`;
  await pool.query('INSERT INTO users(id,username) VALUES ($1,$2)', [userId, `fence-${userId}`]);
  await pool.query('INSERT INTO provider_connections(id,user_id,provider) VALUES ($1,$2,$3)', [connectionId, userId, provider]);
  await pool.query("INSERT INTO email_accounts(id,user_id,name,email_address,imap_host,imap_port,smtp_host,smtp_port,auth_user,auth_pass) VALUES ($1,$2,'Calendar','calendar@example.test','example.test',993,'example.test',587,'user','unused')", [accountId, userId]);
  return { provider, userId, connectionId, accountId, remoteCalendarId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function operation(f: Fixture, override: { status?: string; action?: string; resourceType?: string; payload?: object; result?: object; connectionId?: string; userId?: string; accountId?: string } = {}) {
  const id = randomUUID();
  const payload = { version: 1, provider: f.provider, action: 'delete', accountId: f.accountId, connectionId: f.connectionId, remoteCalendarId: f.remoteCalendarId, ...override.payload };
  const result = { provider: f.provider, action: 'delete', remoteCalendarId: f.remoteCalendarId, name: null, ...override.result };
  await pool.query(`INSERT INTO provider_operations(id,user_id,account_id,connection_id,resource_type,operation,status,payload,result)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, override.userId ?? f.userId, override.accountId ?? f.accountId, override.connectionId ?? f.connectionId, override.resourceType ?? 'calendar_collection', override.action ?? 'delete', override.status ?? 'committed', payload, result]);
  return id;
}
function ensure(client: PoolClient, f: Fixture) {
  return f.provider === 'google'
    ? ensureGoogleCalendarCollection(client, { ...f, entry: { id: f.remoteCalendarId, summary: 'Calendar', accessRole: 'owner' } })
    : ensureGraphCalendarCollection(client, { ...f, entry: { id: f.remoteCalendarId, name: 'Calendar', canEdit: true } });
}
async function fence(f: Fixture, operationId?: string) {
  const id = operationId ?? await operation(f);
  return withTransaction(client => recordCalendarDeletionFence(client, { ...f, operationId: id }));
}
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
function sync(f: Fixture, fetchImpl: (url: string) => Promise<Response>) {
  return f.provider === 'google' ? syncGoogleCalendar({ ...f, config, fetchImpl }) : syncGraphCalendar({ ...f, config, fetchImpl });
}
function discovery(f: Fixture) {
  return f.provider === 'google' ? { items: [{ id: f.remoteCalendarId, summary: 'Calendar', accessRole: 'owner' }] }
    : { value: [{ id: f.remoteCalendarId, name: 'Calendar', canEdit: true }] };
}

suite('calendar collection lifecycle fences (real PostgreSQL)', { timeout: 30_000 }, () => {
  afterEach(async () => { for (const id of users.splice(0)) await pool.query('DELETE FROM users WHERE id=$1', [id]); });

  it.each(['pending', 'in_flight', 'accepted_pending', 'outcome_unknown', 'failed'])('refuses %s operation evidence', async status => {
    const f = await fixture('google'); const operationId = await operation(f, { status });
    await expect(fence(f, operationId)).rejects.toThrow('matching committed');
    expect(await withTransaction(c => isCalendarCollectionDeleted(c, f))).toBe(false);
  });
  it.each([
    { resourceType: 'calendar_event' }, { action: 'create' }, { payload: { version: 2 } },
    { payload: { remoteCalendarId: 'another' } }, { result: { remoteCalendarId: 'another' } },
    { payload: { connectionId: randomUUID() } }, { payload: { accountId: randomUUID() } },
    { payload: { provider: 'microsoft' } }, { result: { provider: 'microsoft' } },
    { result: { action: 'create' } }, { payload: { action: 'create' } },
  ])('refuses mismatched committed evidence %j', async override => {
    const f = await fixture('google'); const operationId = await operation(f, override);
    await expect(fence(f, operationId)).rejects.toThrow('matching committed');
    expect(await withTransaction(c => isCalendarCollectionDeleted(c, f))).toBe(false);
  });
  it('does not coerce numeric JSON identity into a remote calendar string', async () => {
    const f = { ...await fixture('google'), remoteCalendarId: '123' };
    const id = await operation(f, { payload: { remoteCalendarId: 123 }, result: { remoteCalendarId: 123 } });
    await expect(fence(f, id)).rejects.toThrow('matching committed');
  });
  it('rejects foreign ownership and operations from another owned connection', async () => {
    const f = await fixture('google'); const other = await fixture('google');
    await expect(withTransaction(c => lockCalendarCollection(c, { ...f, userId: other.userId }))).rejects.toThrow('not owned');
    await expect(fence(f, await operation(other))).rejects.toThrow('matching committed');
    const connectionId = randomUUID();
    await pool.query("INSERT INTO provider_connections(id,user_id,provider) VALUES ($1,$2,'google')", [connectionId, f.userId]);
    await expect(fence(f, await operation(f, { connectionId }))).rejects.toThrow('matching committed');
  });
  it('records exact direct journal result idempotently and retains original evidence', async () => {
    const f = await fixture('google'); const id = await operation(f);
    await fence(f, id); await fence(f, id); await fence(f);
    expect((await pool.query('SELECT operation_id FROM calendar_collection_tombstones WHERE user_id=$1', [f.userId])).rows).toEqual([{ operation_id: id }]);
  });

  it('preserves a fence when account deletion removes its journal operation', async () => {
    const f = await fixture('google'); await fence(f);
    await pool.query('DELETE FROM email_accounts WHERE id=$1', [f.accountId]);
    expect((await pool.query('SELECT operation_id FROM calendar_collection_tombstones WHERE user_id=$1', [f.userId])).rows).toEqual([{ operation_id: null }]);
    await withTransaction(c => ensure(c, f));
    expect((await pool.query('SELECT id FROM calendars WHERE user_id=$1', [f.userId])).rows).toEqual([]);
  });

  for (const provider of ['google', 'microsoft'] as const) describe(provider, () => {
    it('suppresses a stale discovery without creating any local projection', async () => {
      const f = await fixture(provider); await fence(f);
      await withTransaction(c => ensure(c, f));
      expect((await pool.query('SELECT id FROM calendars WHERE user_id=$1', [f.userId])).rows).toEqual([]);
      expect((await pool.query('SELECT id FROM integration_collections WHERE user_id=$1', [f.userId])).rows).toEqual([]);
    });
    it('serializes concurrent ensures to one link and one local calendar without orphans', async () => {
      const f = await fixture(provider);
      await Promise.all(Array.from({ length: 8 }, () => withTransaction(c => ensure(c, f))));
      expect((await pool.query('SELECT id FROM calendars WHERE user_id=$1', [f.userId])).rows).toHaveLength(1);
      expect((await pool.query('SELECT local_calendar_id FROM integration_collections WHERE user_id=$1', [f.userId])).rows).toHaveLength(1);
      await pool.query("UPDATE integration_collections SET enabled=false,user_access='read_only' WHERE user_id=$1", [f.userId]);
      await withTransaction(c => ensure(c, f));
      expect((await pool.query('SELECT enabled,user_access FROM integration_collections WHERE user_id=$1', [f.userId])).rows).toEqual([{ enabled: false, user_access: 'read_only' }]);
    });
    it('does not schedule an enabled linked collection once fenced, without deleting its projection', async () => {
      const f = await fixture(provider); await withTransaction(c => ensure(c, f)); await fence(f);
      const fetchImpl = vi.fn(async () => json(discovery(f)));
      const result = await sync(f, fetchImpl);
      expect(result.collections).toBe(0); expect(result.errors).toEqual([]); expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect((await pool.query('SELECT id FROM calendars WHERE user_id=$1', [f.userId])).rows).toHaveLength(1);
      expect((await pool.query('SELECT enabled FROM integration_collections WHERE user_id=$1', [f.userId])).rows).toEqual([{ enabled: true }]);
      expect((await pool.query('SELECT id FROM sync_states WHERE user_id=$1', [f.userId])).rows).toEqual([]);
    });
    it.each([false, true])('rejects in-flight projection/checkpoint after a confirmed fence (empty page: %s)', async emptyPage => {
      const f = await fixture(provider); let calls = 0;
      const fetchImpl = async () => {
        if (++calls === 1) return json(discovery(f));
        await fence(f);
        return json(provider === 'google'
          ? { items: emptyPage ? [] : [{ id: 'event', summary: 'Late event', start: { dateTime: '2026-01-01T09:00:00Z' }, end: { dateTime: '2026-01-01T10:00:00Z' } }], nextSyncToken: 'late-cursor' }
          : { value: emptyPage ? [] : [{ id: 'event', subject: 'Late event', start: { dateTime: '2026-01-01T09:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-01-01T10:00:00', timeZone: 'UTC' } }], '@odata.deltaLink': 'https://graph.microsoft.com/beta/me/calendars/c/events/delta?$deltatoken=late' });
      };
      const result = await sync(f, fetchImpl);
      expect(result.errors).toEqual([{ calendarId: f.remoteCalendarId, code: 'RESOURCE_NOT_FOUND' }]);
      expect((await pool.query('SELECT id FROM calendar_events WHERE user_id=$1', [f.userId])).rows).toEqual([]);
      const states = (await pool.query('SELECT cursor,running_owner FROM sync_states WHERE user_id=$1', [f.userId])).rows;
      expect(states).toEqual([{ cursor: null, running_owner: null }]);
    });
  });
});
