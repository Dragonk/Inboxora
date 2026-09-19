import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), runProviderMutation: vi.fn(), create: vi.fn(), patch: vi.fn(), remove: vi.fn() }));

vi.mock('./db.js', () => ({ query: mocks.query }));
vi.mock('./providerMutationService.js', () => ({ runProviderMutation: mocks.runProviderMutation }));
vi.mock('./providerAuthService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providerAuthService.js')>()),
  microsoftConfigFromEnv: () => ({ clientId: 'ms-client', clientSecret: 'ms-secret', redirectUri: '', tenantId: 'common' }),
}));
vi.mock('./providers/microsoft/graphCalendarWrites.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providers/microsoft/graphCalendarWrites.js')>()),
  createGraphEvent: mocks.create,
  patchGraphEvent: mocks.patch,
  deleteGraphEvent: mocks.remove,
}));

import {
  graphEventIdForLocalRow,
  resolveCalendarWriteTarget,
  writeGraphCalendarEvent,
} from './providerCalendarWrites.js';

const calendar = (overrides: Record<string, unknown> = {}) => ({
  id: 'calendar-1', source: 'local', collection_id: null, remote_id: null,
  connection_id: null, source_access: null, user_access: null, ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runProviderMutation.mockResolvedValue({ status: 'confirmed', operationId: 'op-1', replayed: false, value: { event: { id: 'AAMkAD-evt-1' } } });
});

describe('which writer owns a calendar', () => {
  it('treats a calendar with no collection row as local', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [calendar()] });
    await expect(resolveCalendarWriteTarget('user-1', 'calendar-1')).resolves.toEqual({ kind: 'local' });
  });

  it('refuses a provider calendar the user has not enabled for write-back', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [calendar({
      source: 'microsoft', collection_id: 'collection-1', remote_id: 'cal-1',
      connection_id: 'connection-1', source_access: 'read_write', user_access: 'source',
    })] });
    await expect(resolveCalendarWriteTarget('user-1', 'calendar-1')).resolves.toMatchObject({ kind: 'refused', status: 403 });
  });

  it('refuses a calendar the provider marked as not editable', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [calendar({
      source: 'microsoft', collection_id: 'collection-1', remote_id: 'cal-1',
      connection_id: 'connection-1', source_access: 'read_only', user_access: 'read_write',
    })] });
    await expect(resolveCalendarWriteTarget('user-1', 'calendar-1')).resolves.toMatchObject({ kind: 'refused', status: 403 });
  });

  it('resolves a write-enabled Microsoft calendar to its connection and provider calendar id', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [calendar({
      source: 'microsoft', collection_id: 'collection-1', remote_id: 'cal-1',
      connection_id: 'connection-1', source_access: 'read_write', user_access: 'read_write',
    })] });
    await expect(resolveCalendarWriteTarget('user-1', 'calendar-1')).resolves.toEqual({
      kind: 'graph', connectionId: 'connection-1', collectionId: 'collection-1', providerCalendarId: 'cal-1', calendarId: 'calendar-1',
    });
  });

  it('refuses a source whose calendar write path does not exist in this route', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [calendar({
      source: 'google', collection_id: 'collection-1', remote_id: 'cal-1',
      connection_id: 'connection-1', source_access: 'read_write', user_access: 'read_write',
    })] });
    await expect(resolveCalendarWriteTarget('user-1', 'calendar-1')).resolves.toMatchObject({ kind: 'refused', status: 403 });
  });
});

describe('running a calendar write through the journal', () => {
  const target = { kind: 'graph' as const, connectionId: 'connection-1', collectionId: 'collection-1', providerCalendarId: 'cal-1', calendarId: 'calendar-1' };
  const event = {
    summary: 'Standup', description: null, location: null, url: null,
    startsAt: new Date('2026-09-01T09:00:00.000Z'), endsAt: new Date('2026-09-01T09:30:00.000Z'),
    allDay: false, attendees: [], recurrence: null,
  };

  it('sends the intent id as Graph’s own idempotency transaction id', async () => {
    const outcome = await writeGraphCalendarEvent({
      userId: 'user-1', target, operation: 'create', event, idempotencyKey: 'intent-1',
    });
    expect(outcome).toMatchObject({ status: 'confirmed', providerEventId: 'AAMkAD-evt-1' });
    const [request] = mocks.runProviderMutation.mock.calls[0] as [Record<string, unknown>];
    expect(request).toMatchObject({ operation: 'create', collectionId: 'collection-1' });
    expect((request.payload as { transactionId?: string }).transactionId).toBe('intent-1');
  });

  it('journals Inboxora’s own resource id, never the provider’s', async () => {
    // `provider_operations.resource_id` is a UUID column; the provider's `AAMkAD-…` id travels in the
    // payload. Binding it in that column fails the INSERT before any provider call, which the mocked
    // mutation layer cannot show — this pins the value the service passes.
    await writeGraphCalendarEvent({
      userId: 'user-1', target, operation: 'update', providerEventId: 'AAMkAD-evt-1',
      localResourceId: '11111111-2222-4333-8444-555555555555', event,
    });
    const [request] = mocks.runProviderMutation.mock.calls[0] as [Record<string, unknown>];
    expect(request.resourceId).toBe('11111111-2222-4333-8444-555555555555');
    expect((request.payload as { eventId?: string }).eventId).toBe('AAMkAD-evt-1');
  });

  it('maps a refusal onto the shared write failure vocabulary', async () => {
    mocks.runProviderMutation.mockResolvedValueOnce({ status: 'outcome_unknown', operationId: 'op-1', replayed: false });
    const outcome = await writeGraphCalendarEvent({ userId: 'user-1', target, operation: 'update', providerEventId: 'AAMkAD-evt-1', event });
    expect(outcome).toMatchObject({ status: 'failed', failure: { status: 502, code: 'MUTATION_OUTCOME_UNKNOWN' } });
  });

  it('refuses to call a create confirmed without an identity', async () => {
    mocks.runProviderMutation.mockResolvedValueOnce({ status: 'confirmed', operationId: 'op-1', replayed: false, value: { event: null } });
    const outcome = await writeGraphCalendarEvent({ userId: 'user-1', target, operation: 'create', event });
    expect(outcome).toMatchObject({ status: 'failed', failure: { status: 502, code: 'EVENT_ID_MISSING' } });
  });

  it('reads the provider event id from an active link only', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ object_remote_id: 'AAMkAD-evt-1' }] });
    await expect(graphEventIdForLocalRow('user-1', 'collection-1', 'event-1')).resolves.toBe('AAMkAD-evt-1');
    const [sql] = mocks.query.mock.calls[0] as [string];
    expect(sql).toContain("object_type = 'calendar_event'");
    expect(sql).toContain("status = 'active'");
  });
});
