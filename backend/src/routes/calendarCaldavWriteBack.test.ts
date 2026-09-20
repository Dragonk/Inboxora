import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listeningPort } from '../test/net.js';
import type { Server } from 'node:http';

/**
 * Editing an external CalDAV collection from the web interface.
 *
 * A DAV client's `PUT`/`DELETE` already reached the source; the web editor did not, so a collection the user
 * had enabled write-back for was reported editable and then refused. These cases pin the web path onto the
 * same write-back client, for a create, an update, a delete and all three scopes of a series mutation.
 */

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  resolveTarget: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
  sendInvitation: vi.fn(async () => ({ accepted: [], rejected: [] })),
}));

vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: vi.fn(async (callback: (client: { query: typeof mocks.query }) => unknown) => callback({ query: mocks.query })) }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../services/providers/caldavWriteBack.js', () => ({
  putCaldavEvent: mocks.put,
  deleteCaldavEvent: mocks.remove,
}));
vi.mock('../services/calendarInvitation.js', () => ({
  sendCalendarInvitation: mocks.sendInvitation,
  prepareCalendarInvitation: async () => ({ dispatch: mocks.sendInvitation }),
}));
vi.mock('../services/externalCalendarSync.js', () => ({
  releaseCalendarSource: vi.fn(), scheduleCalendarSource: vi.fn(), stopCalendarSource: vi.fn(), syncCalendarSource: vi.fn(),
}));
vi.mock('../services/providerCalendarWrites.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/providerCalendarWrites.js')>()),
  resolveCalendarWriteTarget: mocks.resolveTarget,
}));

import express from 'express';
import calendarRouter from './calendar.js';

const CALDAV_TARGET = {
  kind: 'caldav' as const,
  collectionId: 'collection-1',
  calendarId: 'calendar-1',
  externalUrl: 'https://dav.example.test/calendars/user/',
};

const DAILY = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:uid-1',
  'DTSTART:20260105T090000Z', 'DTEND:20260105T100000Z', 'RRULE:FREQ=DAILY;COUNT=10',
  'SUMMARY:Daily', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

let server: Server;
let base = '';

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.resolveTarget.mockResolvedValue(CALDAV_TARGET);
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.put.mockResolvedValue({ status: 'confirmed', created: false, etag: 'etag-new' });
  mocks.remove.mockResolvedValue({ status: 'confirmed', created: false });
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use('/api/calendar', calendarRouter);
    await new Promise<void>((resolve, reject) => { server = app.listen(0, () => resolve()); server.once('error', reject); });
    base = `http://127.0.0.1:${listeningPort(server)}`;
  }
});

const call = (method: string, path: string, body?: unknown) => fetch(`${base}/api/calendar${path}`, {
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const eventBody = {
  calendarId: 'calendar-1', summary: 'Standup', description: 'Daily', location: 'Room 1',
  startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T09:30:00.000Z', attendees: [],
};

describe('creating an event in a write-enabled CalDAV calendar', () => {
  it('forwards the resource to the source and answers with the projected row', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'event-1' }] });
    const response = await call('POST', '/events', eventBody);

    expect(response.status).toBe(201);
    expect(mocks.put).toHaveBeenCalledOnce();
    const write = mocks.put.mock.calls[0]?.[0] as { method: string; exists: boolean; filename: string; raw: string; calendar: { external_url: string } };
    expect(write).toMatchObject({ method: 'PUT', exists: false, calendar: { external_url: 'https://dav.example.test/calendars/user/' } });
    expect(write.filename).toMatch(/\.ics$/);
    expect(write.raw).toContain('SUMMARY:Standup');
  });

  it('sends Inboxora’s own invitation, because a CalDAV source is not a scheduling service', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'account-1', smtp_host: 'smtp.example.test' }] });
    const response = await call('POST', '/events', { ...eventBody, attendees: ['a@example.test'], sendInvites: true, inviteAccountId: 'account-1' });

    expect(response.status).toBe(201);
    expect(mocks.sendInvitation).toHaveBeenCalledWith(expect.objectContaining({ attendees: ['a@example.test'], method: 'REQUEST', summary: 'Standup' }));
  });

  it('reports the conflict instead of pretending the change was saved', async () => {
    mocks.put.mockResolvedValueOnce({ status: 'conflict', created: false, code: 'PRECONDITION_FAILED' });
    const response = await call('POST', '/events', eventBody);

    expect(response.status).toBe(412);
    expect(await response.json()).toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('editing and deleting an event in a write-enabled CalDAV calendar', () => {
  beforeEach(() => {
    mocks.query.mockResolvedValue({ rows: [{ id: 'event-1', uid: 'uid-1', raw_ical: DAILY, etag: 'etag-1', dav_filename: 'uid-1.ics' }] });
  });

  it('merges into the stored resource and forwards it with the stored entity-tag', async () => {
    const response = await call('PATCH', '/events/event-1', { ...eventBody, summary: 'Standup (moved)' });

    expect(response.status).toBe(200);
    const write = mocks.put.mock.calls[0]?.[0] as { method: string; exists: boolean; localRevision: string; filename: string; raw: string };
    expect(write).toMatchObject({ method: 'PUT', exists: true, localRevision: 'etag-1', filename: 'uid-1.ics' });
    expect(write.raw).toContain('SUMMARY:Standup (moved)');
    // The series rule is the source's and stays untouched by an edit that did not mention it.
    expect(write.raw).toContain('RRULE:FREQ=DAILY;COUNT=10');
  });

  it('deletes at the source and lets the projection remove the row', async () => {
    const response = await call('DELETE', '/events/event-1?calendarId=calendar-1');

    expect(response.status).toBe(204);
    expect(mocks.remove).toHaveBeenCalledWith(expect.objectContaining({
      method: 'DELETE', filename: 'uid-1.ics', uid: 'uid-1', exists: true, localRevision: 'etag-1',
    }));
    // The write-back client owns the projection; the route must not delete the row itself as well.
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM calendar_events'))).toBe(false);
  });
});

describe('scoped series mutations in a write-enabled CalDAV calendar', () => {
  beforeEach(() => {
    mocks.query.mockResolvedValue({ rows: [{ id: 'event-1', uid: 'uid-1', raw_ical: DAILY, etag: 'etag-1', dav_filename: 'uid-1.ics' }] });
  });

  it('cancels one occurrence by putting the master with that override merged in', async () => {
    const response = await call('DELETE', '/events/event-1/occurrence', { calendarId: 'calendar-1', recurrenceId: '2026-01-09T09:00:00Z', scope: 'single' });

    expect(response.status).toBe(200);
    const raw = (mocks.put.mock.calls[0]?.[0] as { raw: string }).raw;
    expect(raw).toContain('RECURRENCE-ID:20260109T090000');
    expect(raw).toContain('STATUS:CANCELLED');
    // The series itself is untouched.
    expect(raw).toContain('RRULE:FREQ=DAILY;COUNT=10');
  });

  it('ends the series at the source for this-and-following', async () => {
    const response = await call('DELETE', '/events/event-1/occurrence', { calendarId: 'calendar-1', recurrenceId: '2026-01-09T09:00:00Z', scope: 'following' });

    expect(response.status).toBe(200);
    const raw = (mocks.put.mock.calls[0]?.[0] as { raw: string }).raw;
    expect(raw).toContain('RRULE:FREQ=DAILY;UNTIL=20260109T085959Z');
    expect(raw).not.toContain('COUNT=10');
  });

  it('splits the series at the source for a this-and-following edit', async () => {
    const response = await call('PATCH', '/events/event-1/occurrence', {
      calendarId: 'calendar-1', recurrenceId: '2026-01-09T09:00:00Z', scope: 'following',
      summary: 'Daily (moved)', startsAt: '2026-01-09T11:00:00.000Z', endsAt: '2026-01-09T12:00:00.000Z', attendees: [],
    });

    expect(response.status).toBe(200);
    expect(mocks.put).toHaveBeenCalledTimes(2);
    const [master, remainder] = mocks.put.mock.calls.map(call => call[0] as { filename: string; raw: string; exists: boolean });
    expect(master?.raw).toContain('UNTIL=20260109T085959Z');
    expect(remainder?.exists).toBe(false);
    expect(remainder?.filename).toBe('uid-1#20260109T090000Z.ics');
    expect(remainder?.raw).toContain('SUMMARY:Daily (moved)');
    expect(remainder?.raw).toContain('RRULE:FREQ=DAILY;COUNT=10');
  });

  it('edits one occurrence without touching the series rule', async () => {
    const response = await call('PATCH', '/events/event-1/occurrence', {
      calendarId: 'calendar-1', recurrenceId: '2026-01-09T09:00:00Z', scope: 'single',
      summary: 'Daily (this one)', startsAt: '2026-01-09T11:00:00.000Z', endsAt: '2026-01-09T12:00:00.000Z', attendees: [],
    });

    expect(response.status).toBe(200);
    expect(mocks.put).toHaveBeenCalledOnce();
    const raw = (mocks.put.mock.calls[0]?.[0] as { raw: string }).raw;
    expect(raw).toContain('RECURRENCE-ID:20260109T090000');
    expect(raw).toContain('SUMMARY:Daily (this one)');
    expect(raw).toContain('RRULE:FREQ=DAILY;COUNT=10');
  });
});
