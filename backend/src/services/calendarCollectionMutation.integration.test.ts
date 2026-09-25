import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query, withTransaction } from './db.js';
import { beginOperation } from './providerOperations.js';
import { GoogleApiError } from './providers/google/googleApiClient.js';
import { GraphApiError } from './providers/microsoft/graphApiClient.js';
import { buildCalendarCollectionMutationIntent, runCalendarCollectionMutation, type CalendarCollectionMutationInput, type CalendarCollectionMutationOptions, type CalendarCollectionProvider } from './calendarCollectionMutation.js';

const suite = process.env.DB_HOST && process.env.DB_NAME ? describe : describe.skip;
const userId = randomUUID();
const fixtures = new Map<CalendarCollectionProvider, { accountId: string; connectionId: string; collectionId: string; localCalendarId: string }>();
const config = { clientId: 'test-client', clientSecret: 'must-not-be-journaled', redirectUri: 'https://example.test/callback', providerRedirectUri: 'https://example.test/provider-callback', tenantId: 'common' };
const apiOptions: CalendarCollectionMutationOptions = { googleApi: { config }, graphApi: { config } };
function input(provider: CalendarCollectionProvider): CalendarCollectionMutationInput {
  const fixture = fixtures.get(provider)!;
  return { userId, accountId: fixture.accountId, connectionId: fixture.connectionId, provider, action: 'create', name: 'Work', idempotencyKey: `calendar-${provider}` };
}
function options(createCall: () => Promise<void>, deleteCall: () => Promise<void> = async () => {}): CalendarCollectionMutationOptions {
  return { ...apiOptions, calls: {
    createGoogle: async () => { await createCall(); return { id: 'remote/google/calendar', summary: 'Work' }; },
    createGraph: async () => { await createCall(); return { id: 'remote/graph/calendar', name: 'Work' }; },
    deleteGoogle: deleteCall, deleteGraph: deleteCall,
  } };
}

suite('calendar collection durable mutation (PostgreSQL)', () => {
  beforeAll(async () => {
    await query('INSERT INTO users (id,username) VALUES ($1,$2)', [userId, `calendar-mutation-${userId}`]);
    for (const provider of ['google', 'microsoft'] as const) {
      const account = await query<{ id: string }>(`INSERT INTO email_accounts (user_id,name,email_address,imap_host,imap_port,smtp_host,smtp_port,auth_user,auth_pass,mail_transport)
        VALUES ($1,'Calendar test','test@example.test','imap.example.test',993,'smtp.example.test',587,'test','x','imap_smtp') RETURNING id`, [userId]);
      const connection = await query<{ id: string }>('INSERT INTO provider_connections (user_id,provider) VALUES ($1,$2) RETURNING id', [userId, provider]);
      const collection = await query<{ id: string }>("INSERT INTO integration_collections (user_id,connection_id,kind,remote_id) VALUES ($1,$2,'calendar','remote/secondary') RETURNING id", [userId, connection.rows[0]!.id]);
      fixtures.set(provider, { accountId: account.rows[0]!.id, connectionId: connection.rows[0]!.id, collectionId: collection.rows[0]!.id, localCalendarId: randomUUID() });
    }
  });
  beforeEach(async () => { await query('DELETE FROM provider_operations WHERE user_id=$1', [userId]); });
  afterAll(async () => {
    await query('DELETE FROM provider_operations WHERE user_id=$1', [userId]);
    await query('DELETE FROM integration_collections WHERE user_id=$1', [userId]);
    await query('DELETE FROM email_accounts WHERE user_id=$1', [userId]);
    await query('DELETE FROM provider_connections WHERE user_id=$1', [userId]);
    await query('DELETE FROM users WHERE id=$1', [userId]);
  });

  for (const provider of ['google', 'microsoft'] as const) describe(provider, () => {
    it('commits intent before upstream and replays confirmed result after projection failure', async () => {
      let calls = 0;
      const opts = options(async () => {
        calls++;
        const durable = await query('SELECT status,resource_type,resource_id,payload FROM provider_operations WHERE user_id=$1', [userId]);
        expect(durable.rows).toEqual([expect.objectContaining({ status: 'in_flight', resource_type: 'calendar_collection', resource_id: null, payload: expect.objectContaining({ version: 1, provider, action: 'create' }) })]);
      });
      const result = await runCalendarCollectionMutation(input(provider), opts);
      expect(result).toMatchObject({ status: 'confirmed', replayed: false, value: { provider, action: 'create', name: 'Work' } });
      // A subsequent local projection transaction can fail without erasing the separately committed receipt.
      await expect(withTransaction(async client => {
        await client.query('SELECT 1');
        throw new Error('simulated local projection failure');
      })).rejects.toThrow('simulated local projection failure');
      const replay = await runCalendarCollectionMutation(input(provider), opts);
      expect(replay).toMatchObject({ status: 'confirmed', replayed: true, operationId: result.operationId, value: result.value });
      expect(calls).toBe(1);
      const journal = await query('SELECT status,result,payload,payload_hash FROM provider_operations WHERE id=$1', [result.operationId]);
      expect(journal.rows[0]).toMatchObject({ status: 'committed', result: result.value, payload_hash: buildCalendarCollectionMutationIntent(input(provider)).payloadHash });
      expect(JSON.stringify(journal.rows)).not.toContain(config.clientSecret);
      expect(JSON.stringify(journal.rows)).not.toContain('accessToken');
    });
    it('refuses a reused key with changed name or connection without another upstream call', async () => {
      let calls = 0; const opts = options(async () => { calls++; });
      await runCalendarCollectionMutation(input(provider), opts);
      const changedName = { ...input(provider), action: 'create' as const, name: 'Different' };
      expect(await runCalendarCollectionMutation(changedName, opts)).toMatchObject({ status: 'conflict', code: 'IDEMPOTENCY_KEY_REUSED' });
      const otherConnection = fixtures.get(provider === 'google' ? 'microsoft' : 'google')!.connectionId;
      expect(await runCalendarCollectionMutation({ ...input(provider), connectionId: otherConnection }, opts)).toMatchObject({ status: 'conflict' });
      expect(calls).toBe(1);
    });
    it('honors a definitive 429 deadline then permits exactly one safe same-key retry', async () => {
      let calls = 0;
      const ApiError = provider === 'google' ? GoogleApiError : GraphApiError;
      const opts = options(async () => { if (++calls === 1) throw new ApiError({ status: 429, code: 'RATE_LIMITED', message: 'limited', retryable: true, retryAfterSeconds: 60 }); });
      const first = await runCalendarCollectionMutation(input(provider), opts);
      expect(first).toMatchObject({ status: 'retryable', retryAfterSeconds: 60 });
      const early = await runCalendarCollectionMutation(input(provider), opts);
      expect(early).toMatchObject({ status: 'pending', replayed: true });
      expect(early.retryAfterSeconds).toBeGreaterThan(0);
      expect(calls).toBe(1);
      const proof = await query("SELECT upstream_ref->'safe_retry' AS proof, next_attempt_at > NOW() AS future FROM provider_operations WHERE id=$1", [first.operationId]);
      expect(proof.rows[0]).toEqual({ proof: { version: 1, generation: '1' }, future: true });
      await query("UPDATE provider_operations SET next_attempt_at=NOW()-interval '1 second' WHERE id=$1", [first.operationId]);
      const concurrent = await Promise.all([runCalendarCollectionMutation(input(provider), opts), runCalendarCollectionMutation(input(provider), opts)]);
      expect(concurrent).toContainEqual(expect.objectContaining({ status: 'confirmed', replayed: false }));
      expect(concurrent.every(result => result.status === 'confirmed' || result.status === 'pending')).toBe(true);
      expect(await runCalendarCollectionMutation(input(provider), opts)).toMatchObject({ status: 'confirmed', replayed: true });
      expect(calls).toBe(2);
      const final = await query("SELECT upstream_ref->'safe_retry' AS proof, next_attempt_at FROM provider_operations WHERE id=$1", [first.operationId]);
      expect(final.rows[0]).toEqual({ proof: null, next_attempt_at: null });
    });
    it('parks uncertain create permanently rather than automatically calling it again', async () => {
      let calls = 0; const opts = options(async () => { calls++; throw new TypeError('connection reset after dispatch'); });
      const first = await runCalendarCollectionMutation(input(provider), opts);
      const replay = await runCalendarCollectionMutation(input(provider), opts);
      expect(first).toMatchObject({ status: 'outcome_unknown', replayed: false });
      expect(replay).toMatchObject({ status: 'outcome_unknown', replayed: true, operationId: first.operationId });
      expect(calls).toBe(1);
    });
    it('parks a reclaimed in-flight create without upstream redispatch', async () => {
      const intent = buildCalendarCollectionMutationIntent(input(provider));
      const claim = await withTransaction(client => beginOperation(client, { userId, accountId: intent.payload.accountId, connectionId: intent.payload.connectionId, resourceType: 'calendar_collection', operation: 'create', idempotencyKey: intent.idempotencyKey, payloadHash: intent.payloadHash, payload: intent.payload }));
      if (claim.outcome !== 'started') throw new Error(`Unexpected claim ${claim.outcome}`);
      await query("UPDATE provider_operations SET lease_expires_at=NOW()-interval '1 second' WHERE id=$1", [claim.operationId]);
      let calls = 0;
      expect(await runCalendarCollectionMutation(input(provider), options(async () => { calls++; }))).toMatchObject({ status: 'outcome_unknown', replayed: true });
      expect(calls).toBe(0);
    });
    it('journals delete with local UUID and replays it even after collection projection disappears', async () => {
      const fixture = fixtures.get(provider)!;
      const deletion: CalendarCollectionMutationInput = provider === 'google'
        ? { ...input(provider), provider, action: 'delete', remoteCalendarId: 'remote/secondary', collectionId: fixture.collectionId, localCalendarId: fixture.localCalendarId }
        : { ...input(provider), provider, action: 'delete', remoteCalendarId: 'remote/secondary', collectionId: fixture.collectionId, localCalendarId: fixture.localCalendarId, verifiedMailboxIdentity: 'owner@example.test' };
      let calls = 0; const opts = options(async () => {}, async () => { calls++; });
      const first = await runCalendarCollectionMutation(deletion, opts);
      expect(first).toMatchObject({ status: 'confirmed', value: { provider, action: 'delete', remoteCalendarId: 'remote/secondary', name: null } });
      const stored = await query('SELECT resource_id,collection_id FROM provider_operations WHERE id=$1', [first.operationId]);
      expect(stored.rows[0]).toEqual({ resource_id: fixture.localCalendarId, collection_id: fixture.collectionId });
      await query('DELETE FROM integration_collections WHERE id=$1', [fixture.collectionId]);
      expect(await runCalendarCollectionMutation(deletion, opts)).toMatchObject({ status: 'confirmed', replayed: true, value: first.value });
      expect(calls).toBe(1);
    });
  });
});
