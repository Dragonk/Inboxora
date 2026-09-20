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
    resolveGoogleTarget: vi.fn(),
    writeEvent: vi.fn(),
    eventIdForRow: vi.fn(async (): Promise<string | null> => 'evt-1'),
    recordLink: vi.fn(async () => undefined),
    removeLink: vi.fn(async () => undefined),
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
// The local/Microsoft resolution and the Google adapters have their own suites; this one is about the
// order the route writes in, the identity it keeps and what it does when the provider refuses.
vi.mock('../services/providerCalendarWrites.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providerCalendarWrites.js')>()),
  resolveCalendarWriteTarget: mocks.resolveTarget,
  writeGraphCalendarEvent: vi.fn(),
  graphEventIdForLocalRow: vi.fn(),
  recordGraphCalendarEventLink: vi.fn(),
  removeGraphCalendarEventLink: vi.fn(),
}));
vi.mock('../services/providerGoogleWrites.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providerGoogleWrites.js')>()),
  resolveGoogleCalendarWriteTarget: mocks.resolveGoogleTarget,
  writeGoogleCalendarEvent: mocks.writeEvent,
  googleEventIdForLocalRow: mocks.eventIdForRow,
  recordGoogleCalendarEventLink: mocks.recordLink,
  removeGoogleCalendarEventLink: mocks.removeLink,
}));

import express from 'express';
import calendarRouter from './calendar.js';

const GOOGLE_TARGET = {
  kind: 'google' as const,
  connectionId: 'connection-1',
  collectionId: 'collection-1',
  providerCalendarId: 'primary',
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

const providerEvent = { id: 'evt-1', iCalUID: 'standup@google.com' };
const localEventRow = {
  id: 'event-1', calendar_id: 'calendar-1', uid: 'standup@google.com', etag: 'etag-1',
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

/** A refusal from the shared resolver is what makes the route ask whether this is a Google calendar. */
function resolveAsGoogle(): void {
  mocks.resolveTarget.mockResolvedValue({ kind: 'refused', status: 403, error: 'This calendar is written by its source and is read-only' });
  mocks.resolveGoogleTarget.mockResolvedValue(GOOGLE_TARGET);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTarget.mockResolvedValue({ kind: 'local' });
  mocks.resolveGoogleTarget.mockResolvedValue({ kind: 'not_google' });
  mocks.writeEvent.mockResolvedValue({ status: 'confirmed', providerEventId: 'evt-1', event: providerEvent });
  mocks.eventIdForRow.mockResolvedValue('evt-1');
  mocks.query.mockResolvedValue({ rows: [localEventRow] });
});

describe('creating an event in a write-enabled Google calendar', () => {
  beforeEach(resolveAsGoogle);

  it('creates at Google first, keeps its own iCalUID, and does not send a second invitation', async () => {
    const response = await call('POST', '/events', { ...eventBody, sendInvites: true, inviteAccountId: 'account-1' });

    expect(response.status).toBe(201);
    expect(mocks.writeEvent).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'create', sendUpdates: 'all', target: GOOGLE_TARGET,
    }));
    expect(mocks.recordLink).toHaveBeenCalledWith(expect.objectContaining({
      providerEventId: 'evt-1', localId: 'event-1', target: GOOGLE_TARGET,
    }));
    // Google sends the invitation from the insert itself, so Inboxora's own mail must not be a second copy.
    expect(mocks.sendCalendarInvitation).not.toHaveBeenCalled();
    const insert = (mocks.query.mock.calls as Array<[string, unknown[]]>).find(([sql]) => String(sql).includes('INSERT INTO calendar_events'));
    expect(insert?.[1]?.[2]).toBe('standup@google.com');
  });

  it('states `none` when the user asked for no invitations, rather than leaving it to Google', async () => {
    const response = await call('POST', '/events', eventBody);
    expect(response.status).toBe(201);
    expect(mocks.writeEvent).toHaveBeenCalledWith(expect.objectContaining({ sendUpdates: 'none' }));
  });

  it('falls back to the id-derived UID the read path would project', async () => {
    mocks.writeEvent.mockResolvedValueOnce({ status: 'confirmed', providerEventId: 'evt-1', event: { id: 'evt-1' } });
    await call('POST', '/events', eventBody);
    const insert = (mocks.query.mock.calls as Array<[string, unknown[]]>).find(([sql]) => String(sql).includes('INSERT INTO calendar_events'));
    expect(insert?.[1]?.[2]).toBe('evt-1@google.com');
  });

  it('writes nothing locally when Google refuses', async () => {
    mocks.writeEvent.mockResolvedValueOnce({
      status: 'failed', failure: { status: 503, error: 'The provider is temporarily unavailable. Please try again shortly.', code: 'RATE_LIMITED' },
    });
    const response = await call('POST', '/events', eventBody);

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(ranQuery('INSERT INTO calendar_events')).toBe(false);
    expect(mocks.recordLink).not.toHaveBeenCalled();
  });

  it('never calls Google when the shared resolver owns the calendar', async () => {
    mocks.resolveTarget.mockResolvedValue({ kind: 'local' });
    mocks.resolveGoogleTarget.mockResolvedValue({ kind: 'google' });
    const response = await call('POST', '/events', { ...eventBody, attendees: [] });

    expect(response.status).toBe(201);
    expect(mocks.writeEvent).not.toHaveBeenCalled();
    expect(mocks.resolveGoogleTarget).not.toHaveBeenCalled();
  });
});

describe('editing an event in a write-enabled Google calendar', () => {
  beforeEach(() => {
    resolveAsGoogle();
    mocks.query.mockResolvedValue({ rows: [localEventRow] });
  });

  it('updates Google before the local projection, carrying the local row identity', async () => {
    const response = await call('PATCH', '/events/event-1', { ...eventBody, summary: 'Standup (moved)', sendInvites: true, inviteAccountId: 'account-1' });

    expect(response.status).toBe(200);
    expect(mocks.writeEvent).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'update', providerEventId: 'evt-1', sendUpdates: 'all', localResourceId: 'event-1',
    }));
    expect(ranQuery('UPDATE calendar_events SET')).toBe(true);
    expect(mocks.sendCalendarInvitation).not.toHaveBeenCalled();
  });

  it('clears the series at Google when the edit makes the event a one-off', async () => {
    // Recurring → non-recurring is the case a PATCH that simply omitted the field gets wrong: Google keeps
    // repeating the event while the local copy becomes a one-off. The route must say "clear" explicitly.
    const response = await call('PATCH', '/events/event-1', { ...eventBody, recurrence: null });

    expect(response.status).toBe(200);
    expect(mocks.writeEvent).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'update',
      event: expect.objectContaining({ recurrence: null }),
    }));
  });

  it('says nothing about the rule when the edit does not mention it', async () => {
    await call('PATCH', '/events/event-1', eventBody);

    // Absent means "keep the stored rule": sending a value here would silently drop a series on any edit.
    const written = mocks.writeEvent.mock.calls[0]?.[0] as { event?: { recurrence?: unknown } } | undefined;
    expect(written?.event).not.toHaveProperty('recurrence');
  });

  it('refuses an event that is not linked to its provider copy yet', async () => {
    mocks.eventIdForRow.mockResolvedValueOnce(null);
    const response = await call('PATCH', '/events/event-1', eventBody);

    expect(response.status).toBe(409);
    expect(mocks.writeEvent).not.toHaveBeenCalled();
    expect(ranQuery('UPDATE calendar_events SET')).toBe(false);
  });

  it('leaves the local row untouched when Google refuses', async () => {
    mocks.writeEvent.mockResolvedValueOnce({ status: 'failed', failure: { status: 403, error: 'The provider refused this change', code: 'INSUFFICIENT_SCOPES' } });
    const response = await call('PATCH', '/events/event-1', eventBody);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'INSUFFICIENT_SCOPES' });
    expect(ranQuery('UPDATE calendar_events SET')).toBe(false);
  });

  it('reports a Google collection this installation may not write with its own reason', async () => {
    mocks.resolveGoogleTarget.mockResolvedValue({ kind: 'refused', status: 409, error: 'Google API is not configured by the administrator' });
    const response = await call('PATCH', '/events/event-1', eventBody);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: 'Google API is not configured by the administrator' });
    expect(mocks.writeEvent).not.toHaveBeenCalled();
  });
});

describe('deleting an event in a write-enabled Google calendar', () => {
  it('removes it at Google, tombstones the link and deletes the local row', async () => {
    resolveAsGoogle();
    mocks.query.mockResolvedValue({ rows: [localEventRow] });

    const response = await call('DELETE', '/events/event-1?calendarId=calendar-1');

    expect(response.status).toBe(204);
    expect(mocks.writeEvent).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'delete', providerEventId: 'evt-1', sendUpdates: 'all', localResourceId: 'event-1',
    }));
    expect(mocks.removeLink).toHaveBeenCalledWith(expect.objectContaining({ providerEventId: 'evt-1' }));
    expect(ranQuery('DELETE FROM calendar_events')).toBe(true);
  });

  it('treats an event Google no longer has as removed', async () => {
    resolveAsGoogle();
    mocks.query.mockResolvedValue({ rows: [localEventRow] });
    mocks.writeEvent.mockResolvedValueOnce({
      status: 'failed', failure: { status: 404, error: 'This item no longer exists at the provider', code: 'RESOURCE_NOT_FOUND' },
    });

    const response = await call('DELETE', '/events/event-1?calendarId=calendar-1');

    expect(response.status).toBe(204);
    expect(ranQuery('DELETE FROM calendar_events')).toBe(true);
  });

  it('keeps the local row when Google refuses for another reason', async () => {
    resolveAsGoogle();
    mocks.query.mockResolvedValue({ rows: [localEventRow] });
    mocks.writeEvent.mockResolvedValueOnce({
      status: 'failed', failure: { status: 502, error: 'The provider did not confirm this change.', code: 'MUTATION_OUTCOME_UNKNOWN' },
    });

    const response = await call('DELETE', '/events/event-1?calendarId=calendar-1');

    expect(response.status).toBe(502);
    expect(mocks.removeLink).not.toHaveBeenCalled();
    expect(ranQuery('DELETE FROM calendar_events')).toBe(false);
  });
});
