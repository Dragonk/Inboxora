import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pool, withTransaction } from './db.js';
import { GOOGLE_GRANT_AUDIENCE, GOOGLE_ISSUER, MICROSOFT_GRANT_AUDIENCE, MICROSOFT_ISSUER, storeOAuthGrant, upsertProviderConnection } from './providerAuthService.js';
import { ensureGoogleCalendarCollection, syncGoogleCalendar } from './providers/google/googleCalendarSync.js';
import { ensureGraphCalendarCollection, syncGraphCalendar } from './providers/microsoft/graphCalendarSync.js';

const suite = process.env.DB_HOST && process.env.DB_NAME ? describe : describe.skip;
const config = { clientId: 'synthetic-native', clientSecret: 'synthetic', redirectUri: 'https://example.test/callback', tenantId: 'common', providerRedirectUri: '' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

suite.each(['google', 'microsoft'] as const)('native %s complete collection discovery (PostgreSQL + fake HTTP)', provider => {
  let userId: string;
  let connectionId: string;
  let originalKey: string | undefined;
  let snapshot: unknown;
  let status: number;
  let beforeList: (() => Promise<void>) | undefined;
  let beforeEvents: (() => Promise<void>) | undefined;
  let calls: string[];
  const entry = (id = 'secondary') => provider === 'google'
    ? { id, summary: 'Synthetic secondary', accessRole: 'owner', primary: false }
    : { id, name: 'Synthetic secondary', canEdit: true, isDefaultCalendar: false };
  const list = (ids: string[]) => provider === 'google' ? { items: ids.map(id => entry(id)) } : { value: ids.map(id => entry(id)) };
  const event = provider === 'google'
    ? { id: 'event', iCalUID: 'event@synthetic.test', summary: 'Synthetic event', start: { dateTime: '2026-09-01T10:00:00Z' }, end: { dateTime: '2026-09-01T11:00:00Z' } }
    : { id: 'event', iCalUId: 'event@synthetic.test', subject: 'Synthetic event', start: { dateTime: '2026-09-01T10:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-09-01T11:00:00', timeZone: 'UTC' } };
  const fetchImpl: typeof fetch = async input => {
    const url = new URL(String(input)); calls.push(url.toString());
    if (url.pathname.endsWith('/calendarList') || url.pathname === '/v1.0/me/calendars') {
      await beforeList?.();
      return json(snapshot, status);
    }
    if (url.pathname.endsWith('/events') || url.pathname.endsWith('/events/delta')) {
      await beforeEvents?.();
      return json(provider === 'google' ? { items: [event], nextSyncToken: 'synthetic-token' } : { value: [event] });
    }
    if (provider === 'microsoft' && url.pathname.endsWith('/events/event')) return json(event);
    throw new Error(`Unexpected synthetic provider request: ${url}`);
  };
  const sync = (maxDiscoveryPages?: number, connection = connectionId, user = userId) => provider === 'google'
    ? syncGoogleCalendar({ userId: user, connectionId: connection, config, fetchImpl, maxDiscoveryPages })
    : syncGraphCalendar({ userId: user, connectionId: connection, config, fetchImpl, maxDiscoveryPages });
  async function seedConnection(subject = randomUUID(), owner = userId) {
    return withTransaction(async client => {
      const id = await upsertProviderConnection(client, { userId: owner, provider, issuer: provider === 'google' ? GOOGLE_ISSUER : MICROSOFT_ISSUER, subject });
      await storeOAuthGrant(client, { connectionId: id, audience: provider === 'google' ? GOOGLE_GRANT_AUDIENCE : MICROSOFT_GRANT_AUDIENCE, accessToken: 'synthetic-only', refreshToken: null, expiresAt: new Date(Date.now() + 3600000), scopes: provider === 'google' ? ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events'] : ['https://graph.microsoft.com/Calendars.ReadWrite'], clientIdAtIssue: config.clientId });
      return id;
    });
  }
  async function projection(connection = connectionId) {
    return (await pool.query<{ id: string; local_calendar_id: string | null; enabled: boolean }>("SELECT id,local_calendar_id,enabled FROM integration_collections WHERE connection_id=$1 AND user_id=$2 AND kind='calendar' ORDER BY remote_id", [connection, userId])).rows;
  }
  beforeEach(async () => {
    originalKey = process.env.ENCRYPTION_KEY; process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
    userId = randomUUID(); await pool.query('INSERT INTO users (id,username) VALUES ($1,$2)', [userId, `native-discovery-${userId}`]);
    connectionId = await seedConnection(); snapshot = list(['secondary']); status = 200; beforeList = undefined; beforeEvents = undefined; calls = [];
  });
  afterEach(async () => {
    await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = originalKey;
  });

  it('retires a complete absence with events, occurrences, DAV changes and links; a newer complete snapshot restores subscriptions with a fresh baseline', async () => {
    expect((await sync()).errors).toEqual([]);
    const [row] = await projection();
    await pool.query(`INSERT INTO calendar_occurrences (event_id,calendar_id,user_id,starts_at,ends_at)
      SELECT id,calendar_id,user_id,starts_at,ends_at FROM calendar_events WHERE calendar_id=$1`, [row.local_calendar_id]);
    expect((await pool.query('SELECT 1 FROM calendar_sync_changes WHERE calendar_id=$1', [row.local_calendar_id])).rowCount).toBeGreaterThan(0);
    snapshot = list([]); await sync(); await sync();
    expect(await projection()).toEqual([{ id: row.id, local_calendar_id: null, enabled: false }]);
    for (const table of ['calendar_events', 'calendar_occurrences', 'calendar_sync_changes']) {
      expect((await pool.query(`SELECT 1 FROM ${table} WHERE calendar_id=$1`, [row.local_calendar_id])).rowCount).toBe(0);
    }
    expect((await pool.query('SELECT 1 FROM calendars WHERE id=$1', [row.local_calendar_id])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM remote_object_links WHERE collection_id=$1', [row.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT retirement_reason FROM calendar_collection_tombstones WHERE connection_id=$1', [connectionId])).rows).toEqual([{ retirement_reason: 'complete_discovery' }]);
    calls = [];
    snapshot = list(['secondary', 'new-secondary']); expect((await sync()).collections).toBe(2);
    expect((await projection()).filter(item => item.local_calendar_id && item.enabled)).toHaveLength(2);
    expect((await pool.query('SELECT 1 FROM calendar_events WHERE user_id=$1', [userId])).rowCount).toBe(2);
    if (provider === 'google') expect(calls.filter(url => url.includes('/events')).every(url => !new URL(url).searchParams.has('syncToken'))).toBe(true);
    expect((await pool.query('SELECT 1 FROM calendar_collection_tombstones WHERE connection_id=$1', [connectionId])).rowCount).toBe(0);
    if (provider === 'google') expect(calls.filter(url => url.includes('/calendarList')).every(url => new URL(url).searchParams.get('showHidden') === 'true')).toBe(true);
  });

  it('restores a disabled subscription without overriding the user preference', async () => {
    await sync(); const [row] = await projection();
    await pool.query('UPDATE integration_collections SET enabled=false WHERE id=$1', [row.id]);
    snapshot = list([]); await sync();
    snapshot = list(['secondary']); await sync();
    const [restored] = await projection();
    expect(restored.id).toBe(row.id); expect(restored.local_calendar_id).not.toBeNull();
    expect(restored.enabled).toBe(false);
  });

  it('does not clear a confirmed deletion fence from a newer discovery', async () => {
    await sync();
    snapshot = list([]); await sync();
    await pool.query("UPDATE calendar_collection_tombstones SET retirement_reason='confirmed_delete' WHERE connection_id=$1", [connectionId]);
    snapshot = list(['secondary']); await sync();
    expect((await projection()).every(row => row.local_calendar_id === null)).toBe(true);
    expect((await pool.query('SELECT 1 FROM calendars WHERE user_id=$1', [userId])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM calendar_collection_tombstones WHERE connection_id=$1', [connectionId])).rowCount).toBe(1);
  });

  it.each([{}, { items: 'bad', value: 'bad' }, { items: [{}], value: [{}] }])('rejects malformed snapshot %j without erasing projections', async malformed => {
    await sync(); const rows = await projection(); snapshot = malformed;
    await expect(sync()).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(await projection()).toEqual(rows);
    expect((await pool.query('SELECT 1 FROM calendar_collection_tombstones WHERE connection_id=$1', [connectionId])).rowCount).toBe(0);
  });

  it.each([401, 403, 404, 429, 500])('retains projections after discovery HTTP %i', async failure => {
    await sync(); const rows = await projection(); status = failure; snapshot = { error: { message: 'synthetic failure' } };
    await expect(sync()).rejects.toBeDefined(); expect(await projection()).toEqual(rows);
  });

  it('retains projections when consent is revoked during discovery', async () => {
    await sync(); const rows = await projection(); snapshot = list([]);
    beforeList = async () => { await pool.query("UPDATE oauth_grants SET current_scopes='{}' WHERE connection_id=$1", [connectionId]); };
    await expect(sync()).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPES' }); expect(await projection()).toEqual(rows);
  });

  it('retains projections when the owning account disables calendars during discovery', async () => {
    await sync(); const rows = await projection(); snapshot = list([]);
    const accountId = randomUUID();
    await pool.query(`INSERT INTO email_accounts (id,user_id,name,email_address,imap_host,imap_port,smtp_host,smtp_port,provider_connection_id)
      VALUES ($1,$2,'Synthetic','calendar@synthetic.test','example.test',993,'example.test',587,$3)`, [accountId,userId,connectionId]);
    await pool.query("INSERT INTO account_provider_feature_settings(account_id,feature,enabled) VALUES($1,'calendars',true)", [accountId]);
    beforeList = async () => { await pool.query("UPDATE account_provider_feature_settings SET enabled=false WHERE account_id=$1 AND feature='calendars'", [accountId]); };
    await expect(sync()).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPES' }); expect(await projection()).toEqual(rows);
  });

  it('retains projections after a discovery network timeout', async () => {
    await sync(); const rows = await projection(); snapshot = list([]);
    beforeList = async () => { throw new Error('Synthetic network timeout'); };
    await expect(sync()).rejects.toThrow('Synthetic network timeout'); expect(await projection()).toEqual(rows);
  });

  it('does not reconcile a capped partial snapshot', async () => {
    await sync(); const rows = await projection(); snapshot = provider === 'google' ? { items: [], nextPageToken: 'next' } : { value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars?$skiptoken=next' };
    await expect(sync(1)).rejects.toMatchObject({ code: 'PARTIAL_SYNC' }); expect(await projection()).toEqual(rows);
  });

  it('rejects a superseded discovery generation without applying its old empty snapshot', async () => {
    await sync(); const rows = await projection(); snapshot = list([]);
    beforeList = async () => { await pool.query("UPDATE sync_states SET running_generation=running_generation+1 WHERE connection_id=$1 AND coverage='collection_discovery'", [connectionId]); };
    await expect(sync()).rejects.toMatchObject({ code: 'SYNC_LEASE_LOST' }); expect(await projection()).toEqual(rows);
  });

  it('fences event pages that finish after a later complete discovery retired the collection', async () => {
    await sync(); let release!: () => void; let started!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    beforeEvents = async () => { started(); await waiting; };
    const old = sync(); await entered;
    snapshot = list([]); await sync(); release();
    expect((await old).errors).toEqual([{ calendarId: 'secondary', code: 'RESOURCE_NOT_FOUND' }]);
    expect((await pool.query('SELECT 1 FROM calendar_events WHERE user_id=$1', [userId])).rowCount).toBe(0);
  });

  it('does not retire a collection created locally after the snapshot began', async () => {
    snapshot = list([]);
    beforeList = async () => {
      await withTransaction(client => provider === 'google'
        ? ensureGoogleCalendarCollection(client, { userId, connectionId, entry: { id: 'created-after-snapshot', summary: 'New calendar', accessRole: 'owner' } })
        : ensureGraphCalendarCollection(client, { userId, connectionId, entry: { id: 'created-after-snapshot', name: 'New calendar', canEdit: true } }));
    };
    expect((await sync()).errors).toEqual([]);
    expect((await projection()).filter(item => item.local_calendar_id)).toHaveLength(1);
    expect((await pool.query('SELECT 1 FROM calendar_collection_tombstones WHERE connection_id=$1', [connectionId])).rowCount).toBe(0);
  });

  it('limits retirement to the owning connection and preserves unrelated local calendars', async () => {
    await sync(); const otherConnection = await seedConnection(); await sync(undefined, otherConnection);
    const other = await projection(otherConnection);
    const local = await pool.query("INSERT INTO calendars (user_id,owner_user_id,name,source) VALUES ($1,$1,'Unrelated local','local') RETURNING id", [userId]);
    snapshot = list([]); await sync(); expect(await projection(otherConnection)).toEqual(other);
    expect((await pool.query('SELECT 1 FROM calendars WHERE id=$1', [local.rows[0].id])).rowCount).toBe(1);
  });
}, 30000);
