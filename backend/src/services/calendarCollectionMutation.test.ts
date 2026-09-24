import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const journal = vi.hoisted(() => vi.fn());
vi.mock('./providerMutationService.js', () => ({ runProviderMutation: journal }));
import { buildCalendarCollectionMutationIntent, calendarCollectionMutationAdapter, runCalendarCollectionMutation, type CalendarCollectionMutationInput, type CalendarCollectionMutationOptions, type CalendarCollectionProvider } from './calendarCollectionMutation.js';
import { GoogleApiError } from './providers/google/googleApiClient.js';
import { GraphApiError } from './providers/microsoft/graphApiClient.js';
import { GoogleCalendarProtectionError, GoogleCalendarManagementResponseError } from './providers/google/googleCalendarManagement.js';
import { GraphCalendarProtectionError, GraphCalendarManagementResponseError } from './providers/microsoft/graphCalendarManagement.js';

const userId = '00000000-0000-0000-0000-000000007e01';
const accountId = '00000000-0000-0000-0000-000000007e02';
const connectionId = '00000000-0000-0000-0000-000000007e03';
const collectionId = '00000000-0000-0000-0000-000000007e04';
const localCalendarId = '00000000-0000-0000-0000-000000007e05';
const base = { userId, accountId, connectionId, idempotencyKey: 'intent-1' };
const create = (provider: CalendarCollectionProvider): CalendarCollectionMutationInput => ({ ...base, provider, action: 'create', name: 'Work' });
const remove = (provider: CalendarCollectionProvider): CalendarCollectionMutationInput => provider === 'google'
  ? { ...base, provider, action: 'delete', remoteCalendarId: 'opaque/provider/id', collectionId, localCalendarId }
  : { ...base, provider, action: 'delete', remoteCalendarId: 'opaque/provider/id', collectionId, localCalendarId, verifiedMailboxIdentity: 'Owner@Example.test' };
const config = { clientId: 'secret-client', clientSecret: 'secret-value', redirectUri: 'https://example.test/callback', providerRedirectUri: 'https://example.test/provider-callback', tenantId: 'common' };
const options: CalendarCollectionMutationOptions = { googleApi: { config }, graphApi: { config } };
const context = () => ({ operationId: 'operation', signal: new AbortController().signal });
beforeEach(() => journal.mockReset().mockResolvedValue({ status: 'pending', operationId: 'operation', replayed: true }));

describe('canonical collection intent', () => {
  it('hashes fixed versioned fields and no credentials', () => {
    const { payload, payloadHash } = buildCalendarCollectionMutationIntent(remove('microsoft'));
    expect(payload).toEqual({ version: 1, provider: 'microsoft', action: 'delete', accountId, connectionId, collectionId, localCalendarId, remoteCalendarId: 'opaque/provider/id', name: null, verifiedMailboxIdentity: 'owner@example.test' });
    expect(payloadHash).toBe(createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
    expect(JSON.stringify(payload)).not.toContain('secret');
    for (const patch of [{ provider: 'google' }, { accountId: localCalendarId }, { connectionId: localCalendarId }, { collectionId: localCalendarId }, { localCalendarId: collectionId }, { remoteCalendarId: 'another' }, { verifiedMailboxIdentity: 'another@example.test' }]) {
      const changed = { ...remove('microsoft'), ...patch } as CalendarCollectionMutationInput;
      expect(buildCalendarCollectionMutationIntent(changed).payloadHash).not.toBe(payloadHash);
    }
    expect(buildCalendarCollectionMutationIntent(create('google')).payloadHash).not.toBe(buildCalendarCollectionMutationIntent({ ...create('google'), action: 'create', name: 'Other' }).payloadHash);
  });
  it.each([{ name: '' }, { name: '\n' }, { name: 'x'.repeat(256) }, { idempotencyKey: '' }, { idempotencyKey: ' key ' }, { idempotencyKey: 'x'.repeat(201) }, { accountId: 'remote-id' }, { connectionId: '' }, { userId: '' }])('rejects invalid fields before journal: %j', async patch => {
    await expect(runCalendarCollectionMutation({ ...create('google'), ...patch } as CalendarCollectionMutationInput, options)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(journal).not.toHaveBeenCalled();
  });
  it.each([{ remoteCalendarId: '..' }, { remoteCalendarId: '' }, { remoteCalendarId: ' padded ' }, { collectionId: 'opaque' }, { localCalendarId: 'opaque' }, { verifiedMailboxIdentity: 'alias-without-address' }])('rejects invalid delete identity before journal: %j', async patch => {
    await expect(runCalendarCollectionMutation({ ...remove('microsoft'), ...patch } as CalendarCollectionMutationInput, options)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(journal).not.toHaveBeenCalled();
  });
  it('uses explicit account/connection and local UUID as resource, retains replay result', async () => {
    const response = { status: 'confirmed', operationId: 'operation', replayed: true, value: { provider: 'google', action: 'delete', remoteCalendarId: 'opaque', name: null } };
    journal.mockResolvedValueOnce(response);
    expect(await runCalendarCollectionMutation(remove('google'), options)).toBe(response);
    expect(journal).toHaveBeenCalledWith(expect.objectContaining({ accountId, connectionId, resourceId: localCalendarId, collectionId, operation: 'delete', idempotencyKey: 'intent-1' }), expect.objectContaining({ resourceType: 'calendar_collection', idempotent: false }));
    await runCalendarCollectionMutation(create('google'), options);
    expect(journal.mock.calls[1]?.[0]).toMatchObject({ resourceId: null, collectionId: null, operation: 'create' });
    expect(JSON.stringify(journal.mock.calls[1]?.[0])).not.toContain('secret');
  });
});

for (const provider of ['google', 'microsoft'] as const) describe(`${provider} adapter`, () => {
  const ApiError = provider === 'google' ? GoogleApiError : GraphApiError;
  const ProtectionError = provider === 'google' ? GoogleCalendarProtectionError : GraphCalendarProtectionError;
  const ResponseError = provider === 'google' ? GoogleCalendarManagementResponseError : GraphCalendarManagementResponseError;
  function adapterWithFailure(error: unknown) {
    const fail = async () => { throw error; };
    return calendarCollectionMutationAdapter(userId, { ...options, calls: { createGoogle: fail, createGraph: fail, deleteGoogle: fail, deleteGraph: fail } });
  }
  it('returns confirmed identities and propagates the operation signal to helpers', async () => {
    const createGoogle = vi.fn(async () => ({ id: 'remote', summary: 'Work' }));
    const createGraph = vi.fn(async () => ({ id: 'remote', name: 'Work' }));
    const deleteGoogle = vi.fn(async () => {}); const deleteGraph = vi.fn(async () => {});
    const adapter = calendarCollectionMutationAdapter(userId, { ...options, calls: { createGoogle, createGraph, deleteGoogle, deleteGraph } });
    const ctx = context();
    expect(adapter.idempotent).toBe(false);
    expect(await adapter.perform(buildCalendarCollectionMutationIntent(create(provider)).payload, ctx)).toEqual({ status: 'committed', value: { provider, action: 'create', remoteCalendarId: 'remote', name: 'Work' } });
    expect(provider === 'google' ? createGoogle : createGraph).toHaveBeenCalledWith(expect.objectContaining({ userId, connectionId, signal: ctx.signal }), 'Work');
    expect(await adapter.perform(buildCalendarCollectionMutationIntent(remove(provider)).payload, ctx)).toEqual({ status: 'committed', value: { provider, action: 'delete', remoteCalendarId: 'opaque/provider/id', name: null } });
    if (provider === 'google') expect(deleteGoogle).toHaveBeenCalledWith(expect.objectContaining({ signal: ctx.signal }), 'opaque/provider/id');
    else expect(deleteGraph).toHaveBeenCalledWith(expect.objectContaining({ signal: ctx.signal }), 'opaque/provider/id', 'owner@example.test');
  });
  it.each([
    { error: new ApiError({ code: 'UPSTREAM_UNAVAILABLE', status: 503, message: 'failed', retryable: true }), status: 'outcome_unknown' },
    { error: new ApiError({ code: 'INTERNAL_ERROR', status: 408, message: 'timeout' }), status: 'outcome_unknown' },
    { error: new ApiError({ code: 'INTERNAL_ERROR', status: 499, message: 'client closed request' }), status: 'outcome_unknown' },
    { error: new ApiError({ code: 'RATE_LIMITED', status: 429, message: 'limited', retryable: true }), status: 'retryable' },
    { error: new ApiError({ code: 'PROVIDER_AUTH_REQUIRED', status: 401, message: 'auth' }), status: 'permanent' },
    { error: new ApiError({ code: 'RESOURCE_NOT_FOUND', status: 404, message: 'missing' }), status: 'permanent' },
    { error: new ProtectionError('not_owner'), status: 'permanent' },
    { error: new ResponseError(), status: 'outcome_unknown' },
    { error: new TypeError('network'), status: 'outcome_unknown' },
    { error: new DOMException('timeout', 'TimeoutError'), status: 'outcome_unknown' },
  ])('classifies helper errors without blind retries: $status / $error', async ({ error, status }) => {
    for (const input of [create(provider), remove(provider)]) expect(await adapterWithFailure(error).perform(buildCalendarCollectionMutationIntent(input).payload, context())).toMatchObject({ status });
  });
  it('does not confirm malformed helper IDs or late cancellation', async () => {
    const abort = new AbortController();
    const adapter = calendarCollectionMutationAdapter(userId, { ...options, calls: {
      createGoogle: async () => ({ id: '', summary: null }), createGraph: async () => ({ id: '', name: null }),
      deleteGoogle: async () => { abort.abort(); }, deleteGraph: async () => { abort.abort(); },
    } });
    expect(await adapter.perform(buildCalendarCollectionMutationIntent(create(provider)).payload, context())).toMatchObject({ status: 'outcome_unknown' });
    expect(await adapter.perform(buildCalendarCollectionMutationIntent(remove(provider)).payload, { operationId: 'operation', signal: abort.signal })).toMatchObject({ status: 'outcome_unknown' });
  });
});
