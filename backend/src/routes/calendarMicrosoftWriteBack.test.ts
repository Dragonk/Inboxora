import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listeningPort } from '../test/net.js';
import type { Server } from 'node:http';

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  return {
    query,
    withTransaction: vi.fn(async (callback: (client: { query: typeof query }) => unknown) => callback({ query })),
    sendCalendarInvitation: vi.fn(async () => ({ accepted: [], rejected: [] })),
    resolveTarget: vi.fn(),
    writeEvent: vi.fn(),
    providerIdForEvent: vi.fn(async (): Promise<string | null> => 'AAMkAD-evt-1'),
    recordLink: vi.fn(async () => undefined),
    removeLink: vi.fn(async () => undefined),
    writeOccurrence: vi.fn(async () => ({ status: 'confirmed' as const, providerOccurrenceId: 'AAMkAD-occ-1', createdSeriesId: null })),
    syncGraph: vi.fn(async () => ({ ok: true })),
    syncGoogle: vi.fn(async () => ({ ok: true })),
  };
});

vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: mocks.withTransaction }));
vi.mock('../services/encryption.js', () => ({
  encrypt: (value: string) => `enc:v1:${value}`,
  decrypt: (value: string) => value?.startsWith('enc:v1:') ? value.slice('enc:v1:'.length) : value,
}));
vi.mock('../services/calendarInvitation.js', () => ({
  sendCalendarInvitation: mocks.sendCalendarInvitation,
  prepareCalendarInvitation: async () => ({ dispatch: mocks.sendCalendarInvitation }),
}));
vi.mock('../services/externalCalendarSync.js', () => ({
  releaseCalendarSource: vi.fn(), scheduleCalendarSource: vi.fn(), stopCalendarSource: vi.fn(), syncCalendarSource: vi.fn(),
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); },
}));
// The provider half and its target resolution are covered by their own suites; this one is about the
// order the route writes in and what it does when the provider refuses.
// The scoped-occurrence machinery has its own suite (`providerCalendarOccurrences.test.ts`); this one is
// about the route: which scope it asks for, what it does with the answer, and what it never writes locally.
vi.mock('../services/providerCalendarOccurrences.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providerCalendarOccurrences.js')>()),
  writeProviderCalendarOccurrence: mocks.writeOccurrence,
}));
vi.mock('../services/providers/microsoft/graphCalendarSync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providers/microsoft/graphCalendarSync.js')>()),
  syncGraphCalendar: mocks.syncGraph,
}));
vi.mock('../services/providers/google/googleCalendarSync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providers/google/googleCalendarSync.js')>()),
  syncGoogleCalendar: mocks.syncGoogle,
}));
vi.mock('../services/providerCalendarWrites.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providerCalendarWrites.js')>()),
  resolveCalendarWriteTarget: mocks.resolveTarget,
  writeGraphCalendarEvent: mocks.writeEvent,
  graphEventIdForLocalRow: mocks.providerIdForEvent,
  recordGraphCalendarEventLink: mocks.recordLink,
  removeGraphCalendarEventLink: mocks.removeLink,
}));

import express from 'express';
import calendarRouter from './calendar.js';

const GRAPH_TARGET = {
  kind: 'graph' as const,
  connectionId: 'connection-1',
  collectionId: 'collection-1',
  providerCalendarId: 'cal-1',
  calendarId: 'calendar-1',
};

const eventBody = {
  calendarId: 'calendar-1',
  summary: 'Standup',
  description: 'Daily',
  allDay: false,
  startsAt: '2026-09-01T09:00:00.000Z',
  endsAt: '2026-09-01T09:30:00.000Z',
  attendees: ['a@example.test'],
};

const providerEvent = { id: 'AAMkAD-evt-1', iCalUId: 'standup@contoso.test' };
const localEventRow = {
  id: 'event-1', calendar_id: 'calendar-1', uid: 'standup@contoso.test', etag: 'etag-1',
  summary: 'Standup', description: 'Daily', location: null, url: null, organizer: null,
  starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T09:30:00.000Z', all_day: false,
  timezone: null, attendees: [], invite_account_id: null, invitation_sequence: 0,
  created_at: '2026-09-01T08:00:00.000Z', updated_at: '2026-09-01T08:00:00.000Z',
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { session: { userId: string } }).session = { userId: 'user-1' }; next(); });
  app.use('/api/calendar', calendarRouter);
  return app;
}

async function call(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) {
  const server: Server = createApp().listen(0);
  const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/calendar${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const parsed = await response.json().catch(() => null) as Record<string, unknown> | null;
  await new Promise(resolve => server.close(resolve));
  return { status: response.status, body: parsed };
}

function ranQuery(fragment: string): boolean {
  return (mocks.query.mock.calls as Array<[string]>).some(([sql]) => String(sql).includes(fragment));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTarget.mockResolvedValue({ kind: 'local' });
  mocks.writeEvent.mockResolvedValue({ status: 'confirmed', providerEventId: 'AAMkAD-evt-1', event: providerEvent });
  mocks.providerIdForEvent.mockResolvedValue('AAMkAD-evt-1');
  mocks.query.mockResolvedValue({ rows: [localEventRow] });
});

describe('creating an event in a write-enabled Microsoft calendar', () => {
  beforeEach(() => {
    mocks.resolveTarget.mockResolvedValue(GRAPH_TARGET);
    // `requireAuth` is mocked, so the local INSERT is the only query this path makes.
    mocks.query.mockResolvedValue({ rows: [localEventRow] });
  });

  it('creates at the provider first, keeps its identity, and does not send a second invitation', async () => {
    const response = await call('POST', '/events', { ...eventBody, sendInvites: true, inviteAccountId: 'account-1' });

    expect(response.status).toBe(201);
    expect(mocks.writeEvent).toHaveBeenCalledWith(expect.objectContaining({ operation: 'create' }));
    expect(mocks.recordLink).toHaveBeenCalledWith(expect.objectContaining({
      providerEventId: 'AAMkAD-evt-1', localId: 'event-1',
    }));
    // Graph notifies attendees itself, so Inboxora's own invitation mail must not be a second copy.
    expect(mocks.sendCalendarInvitation).not.toHaveBeenCalled();
    const insert = (mocks.query.mock.calls as Array<[string, unknown[]]>).find(([sql]) => String(sql).includes('INSERT INTO calendar_events'));
    expect(insert?.[1]?.[2]).toBe('standup@contoso.test');
  });

  it('writes nothing locally when the provider refuses', async () => {
    mocks.writeEvent.mockResolvedValueOnce({
      status: 'failed', failure: { status: 503, error: 'The provider is temporarily unavailable. Please try again shortly.', code: 'RATE_LIMITED' },
    });
    const response = await call('POST', '/events', eventBody);

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(ranQuery('INSERT INTO calendar_events')).toBe(false);
    expect(mocks.recordLink).not.toHaveBeenCalled();
  });
});

describe('editing an event in a write-enabled Microsoft calendar', () => {
  beforeEach(() => {
    mocks.resolveTarget.mockResolvedValue(GRAPH_TARGET);
    mocks.query.mockResolvedValue({ rows: [localEventRow] });
  });

  it('updates the provider before the local projection', async () => {
    const response = await call('PATCH', '/events/event-1', { ...eventBody, summary: 'Standup (moved)' });

    expect(response.status).toBe(200);
    expect(mocks.writeEvent).toHaveBeenCalledWith(expect.objectContaining({ operation: 'update', providerEventId: 'AAMkAD-evt-1' }));
    expect(ranQuery('UPDATE calendar_events SET')).toBe(true);
  });

  it('refuses an event that is not linked to its provider copy yet', async () => {
    mocks.providerIdForEvent.mockResolvedValueOnce(null);
    const response = await call('PATCH', '/events/event-1', eventBody);

    expect(response.status).toBe(409);
    expect(mocks.writeEvent).not.toHaveBeenCalled();
    expect(ranQuery('UPDATE calendar_events SET')).toBe(false);
  });

  it('leaves the local row untouched when the provider refuses', async () => {
    mocks.writeEvent.mockResolvedValueOnce({ status: 'failed', failure: { status: 403, error: 'The provider refused this change', code: 'INSUFFICIENT_SCOPES' } });
    const response = await call('PATCH', '/events/event-1', eventBody);

    expect(response.status).toBe(403);
    expect(ranQuery('UPDATE calendar_events SET')).toBe(false);
  });
});

describe('deleting an event in a write-enabled Microsoft calendar', () => {
  it('removes it at the provider, tombstones the link and deletes the local row', async () => {
    mocks.resolveTarget.mockResolvedValue(GRAPH_TARGET);
    mocks.query.mockResolvedValue({ rows: [localEventRow] });

    const response = await call('DELETE', '/events/event-1?calendarId=calendar-1');

    expect(response.status).toBe(204);
    expect(mocks.writeEvent).toHaveBeenCalledWith(expect.objectContaining({ operation: 'delete', providerEventId: 'AAMkAD-evt-1' }));
    expect(mocks.removeLink).toHaveBeenCalledWith(expect.objectContaining({ providerEventId: 'AAMkAD-evt-1' }));
    expect(ranQuery('DELETE FROM calendar_events')).toBe(true);
  });

  it('treats an event the provider no longer has as removed', async () => {
    mocks.resolveTarget.mockResolvedValue(GRAPH_TARGET);
    mocks.query.mockResolvedValue({ rows: [localEventRow] });
    mocks.writeEvent.mockResolvedValueOnce({
      status: 'failed', failure: { status: 404, error: 'This item no longer exists at the provider', code: 'RESOURCE_NOT_FOUND' },
    });

    const response = await call('DELETE', '/events/event-1?calendarId=calendar-1');

    expect(response.status).toBe(204);
    expect(ranQuery('DELETE FROM calendar_events')).toBe(true);
  });
});

describe('provider write paths that do not exist yet are refused, not written locally', () => {
  beforeEach(() => { mocks.resolveTarget.mockResolvedValue(GRAPH_TARGET); });

  it('refuses adding an invitation to a provider calendar', async () => {
    const response = await call('POST', '/invitations/message-1', { calendarId: 'calendar-1' });
    expect(response.status).toBe(501);
    expect(response.body).toMatchObject({ code: 'OPERATION_FORBIDDEN' });
    expect(ranQuery('INSERT INTO calendar_events')).toBe(false);
  });

  it('changes one occurrence at the provider and projects it, without writing the local row itself', async () => {
    mocks.query.mockResolvedValue({ rows: [localEventRow] });
    const response = await call('PATCH', '/events/event-1/occurrence', {
      calendarId: 'calendar-1', recurrenceId: '2026-09-15T09:00:00Z', scope: 'single',
      startsAt: '2026-09-16T09:00:00.000Z', endsAt: '2026-09-16T09:30:00.000Z', attendees: ['a@example.test'],
    });

    expect(response.status).toBe(200);
    expect(mocks.writeOccurrence).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'single',
      operation: 'update',
      sendUpdates: 'all',
      target: expect.objectContaining({ kind: 'graph', masterProviderId: 'AAMkAD-evt-1', occurrenceStart: '2026-09-15T09:00:00Z' }),
      values: expect.objectContaining({ startsAt: new Date('2026-09-16T09:00:00.000Z'), attendees: ['a@example.test'] }),
    }));
    // Provider first: the projection comes from the collection's own sync, never from a local shortcut.
    expect(mocks.syncGraph).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'connection-1' }));
    expect(ranQuery('UPDATE calendar_events')).toBe(false);
  });

  it('cancels one occurrence, and this-and-following, with the scope the client asked for', async () => {
    mocks.query.mockResolvedValue({ rows: [localEventRow] });

    const single = await call('DELETE', '/events/event-1/occurrence', {
      calendarId: 'calendar-1', recurrenceId: '2026-09-15T09:00:00Z', scope: 'single',
    });
    expect(single.status).toBe(200);
    expect(mocks.writeOccurrence).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'single', operation: 'cancel' }));

    const following = await call('DELETE', '/events/event-1/occurrence', {
      calendarId: 'calendar-1', recurrenceId: '2026-09-15T09:00:00Z', scope: 'following',
    });
    expect(following.status).toBe(200);
    expect(mocks.writeOccurrence).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'following', operation: 'cancel' }));
    expect(ranQuery('UPDATE calendar_events')).toBe(false);
  });

  it('edits this-and-following, carrying the rule the remainder keeps', async () => {
    mocks.query.mockResolvedValue({ rows: [localEventRow] });
    const response = await call('PATCH', '/events/event-1/occurrence', {
      calendarId: 'calendar-1', recurrenceId: '2026-09-15T09:00:00Z', scope: 'following',
      startsAt: '2026-09-16T09:00:00.000Z', endsAt: '2026-09-16T09:30:00.000Z', attendees: ['a@example.test'],
      recurrence: { frequency: 'weekly', interval: 1, byWeekday: [2] },
    });

    expect(response.status).toBe(200);
    expect(mocks.writeOccurrence).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'following',
      operation: 'update',
      values: expect.objectContaining({ recurrence: expect.objectContaining({ frequency: 'weekly' }) }),
    }));
  });

  it('reports a provider refusal and writes nothing locally', async () => {
    mocks.query.mockResolvedValue({ rows: [localEventRow] });
    mocks.writeOccurrence.mockResolvedValueOnce({
      status: 'failed', failure: { status: 409, error: 'This occurrence is not in the provider\u2019s series yet. Refresh the calendar and try again.', code: 'OCCURRENCE_NOT_FOUND' },
    } as never);

    const response = await call('DELETE', '/events/event-1/occurrence', {
      calendarId: 'calendar-1', recurrenceId: '2026-09-15T09:00:00Z', scope: 'single',
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'OCCURRENCE_NOT_FOUND' });
    expect(ranQuery('UPDATE calendar_events')).toBe(false);
  });
});

describe('a local calendar keeps writing locally', () => {
  it('never calls the provider when the target is local', async () => {
    mocks.resolveTarget.mockResolvedValue({ kind: 'local' });
    mocks.query.mockResolvedValue({ rows: [localEventRow] });

    const response = await call('POST', '/events', { ...eventBody, attendees: [] });

    expect(response.status).toBe(201);
    expect(mocks.writeEvent).not.toHaveBeenCalled();
    expect(mocks.recordLink).not.toHaveBeenCalled();
  });
});
