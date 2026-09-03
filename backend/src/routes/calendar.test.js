import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { query, withTransaction, sendCalendarInvitation, scheduleCalendarSource, stopCalendarSource, syncCalendarSource } = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(async (fn) => fn({ query })),
  sendCalendarInvitation: vi.fn(),
  scheduleCalendarSource: vi.fn(),
  stopCalendarSource: vi.fn(),
  syncCalendarSource: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../services/db.js', () => ({ query, withTransaction }));
vi.mock('../services/encryption.js', () => ({ encrypt: (value) => `enc:v1:${value}` }));
vi.mock('../services/calendarInvitation.js', () => ({ sendCalendarInvitation }));
vi.mock('../services/externalCalendarSync.js', () => ({ scheduleCalendarSource, stopCalendarSource, syncCalendarSource }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));

import express from 'express';
import calendarRouter from './calendar.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/calendar', calendarRouter);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  query.mockReset();
  withTransaction.mockClear();
  withTransaction.mockImplementation(async (fn) => fn({ query }));
  sendCalendarInvitation.mockReset();
});

describe('local calendar API', () => {

  it('rejects a CalDAV source without dedicated remote credentials', async () => {
    const response = await fetch(`${base}/api/calendar/sources`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'caldav', url: 'https://calendar.example/dav/', displayName: 'Work' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'CalDAV sources require username and password' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects source URLs that embed credentials', async () => {
    const response = await fetch(`${base}/api/calendar/sources`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'ical_url', url: 'https://user:password@calendar.example/events.ics', displayName: 'Work' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Source URL must not include credentials' });
    expect(query).not.toHaveBeenCalled();
  });

  it('normalizes a webcal source to HTTPS before storing it', async () => {
    query.mockImplementation(async (sql) => sql.includes('INSERT INTO calendar_import_sources')
      ? { rows: [{ id: 'source-1', kind: 'ical_url', url: 'https://calendar.example/events.ics', display_name: 'Work' }] }
      : { rows: [] });
    const response = await fetch(`${base}/api/calendar/sources`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'ical_url', url: 'webcal://calendar.example/events.ics', displayName: 'Work' }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ source: expect.not.objectContaining({ url: expect.anything(), username: expect.anything(), password: expect.anything(), url_fingerprint: expect.anything() }) });
    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO calendar_import_sources'));
    expect(insert[1][2]).toBe('enc:v1:https://calendar.example/events.ics');
    expect(insert[1][3]).toMatch(/^[a-f0-9]{64}$/);
  });

  it('redacts all source secrets from the listing payload', async () => {
    query.mockResolvedValueOnce({ rows: [{
      id: 'source-1', kind: 'ical_url', url: 'enc:v1:ciphertext', username: 'remote-user', password: 'enc:v1:password',
      url_fingerprint: 'fingerprint', display_name: 'Work', color: null, interval_min: 60, enabled: true,
      last_sync_at: null, last_error: 'failure enc:v1:ciphertext',
    }] });

    const response = await fetch(`${base}/api/calendar/sources`);

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.sources).toEqual([{ id: 'source-1', kind: 'ical_url', displayName: 'Work', color: null, intervalMin: 60, enabled: true, lastSyncAt: null, lastError: 'failure [redacted]' }]);
    expect(JSON.stringify(payload)).not.toContain('ciphertext');
    expect(JSON.stringify(payload)).not.toContain('remote-user');
  });

  it('lists only calendars owned by the signed-in user', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'calendar-1', name: 'Personal', source: 'local', read_only: false }] });

    const response = await fetch(`${base}/api/calendar/calendars`);

    expect(response.status).toBe(200);
    expect((await response.json()).calendars).toContainEqual({ id: 'calendar-1', name: 'Personal', source: 'local', read_only: false });
    expect(query.mock.calls[0][0]).toContain('WHERE user_id = $1');
    expect(query.mock.calls[0][1]).toEqual(['user-1']);
  });

  it('adds the read-only contact dates calendar without persisting a duplicate resource', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'calendar-1', name: 'Personal', source: 'local', read_only: false }] });

    const response = await fetch(`${base}/api/calendar/calendars`);

    expect(response.status).toBe(200);
    expect((await response.json()).calendars).toContainEqual(expect.objectContaining({ id: 'contacts-birthdays', source: 'contacts', read_only: true }));
  });

  it('rejects an excessively broad event range before querying the database', async () => {
    const response = await fetch(`${base}/api/calendar/events?from=2026-01-01T00:00:00.000Z&to=2028-01-02T00:00:00.000Z`);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'The requested event range is too large' });
    expect(query).not.toHaveBeenCalled();
  });

  it('requires a sender account and attendee list before sending invitations', async () => {
    const response = await fetch(`${base}/api/calendar/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', sendInvites: true, attendees: ['guest@example.test'],
        startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'A sender account and at least one attendee are required for invitations' });
    expect(query).not.toHaveBeenCalled();
  });

  it('uses only the selected owned SMTP account to deliver a calendar invitation', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [sender] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1' }] });

    const response = await fetch(`${base}/api/calendar/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: 'Planning', sendInvites: true, inviteAccountId: 'account-1', attendees: ['guest@example.test'],
        startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z',
      }),
    });

    expect(response.status).toBe(201);
    expect(query.mock.calls[1][0]).toContain('id = $1 AND user_id = $2');
    expect(query.mock.calls[1][1]).toEqual(['account-1', 'user-1']);
    expect(query.mock.calls[2][0]).toContain('attendees, invite_account_id');
    expect(query.mock.calls[2][1]).toContainEqual(['guest@example.test']);
    expect(sendCalendarInvitation).toHaveBeenCalledWith(expect.objectContaining({ account: sender, attendees: ['guest@example.test'], summary: 'Planning' }));
  });

  it('stores a valid iCalendar representation when creating a local event', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', summary: 'Planning' }] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/calendar/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: 'Planning; review', description: 'Bring notes\nDiscuss scope',
        location: 'Room, 2', startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z',
      }),
    });

    expect(response.status).toBe(201);
    expect(query.mock.calls[1][0]).toContain('raw_ical');
    expect(query.mock.calls[1][1][3]).toMatch(/^BEGIN:VCALENDAR\r\nVERSION:2.0\r\n/);
    expect(query.mock.calls[1][1][3]).toContain('SUMMARY:Planning\\; review');
    expect(query.mock.calls[1][1][3]).toContain('DESCRIPTION:Bring notes\\nDiscuss scope');
    expect(query.mock.calls[1][1][3]).toContain('LOCATION:Room\\, 2');
    expect(query.mock.calls[1][1][3]).toContain('DTSTART:20260901T090000Z');
  });

  it('escapes lone carriage returns in local iCalendar text', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] });

    const response = await fetch(`${base}/api/calendar/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ calendarId: 'calendar-1', description: 'Details\rX-INJECTED: true', startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z' }),
    });

    expect(response.status).toBe(201);
    const rawIcal = query.mock.calls[1][1][3];
    expect(rawIcal).toContain('DESCRIPTION:Details\\nX-INJECTED: true');
    expect(rawIcal).not.toContain('\rX-INJECTED: true');
  });

  it('folds long serialized iCalendar content lines without splitting UTF-8 characters', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] });

    const response = await fetch(`${base}/api/calendar/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: `Release ${'ż'.repeat(40)}`,
        startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z',
      }),
    });

    expect(response.status).toBe(201);
    const rawIcal = query.mock.calls[1][1][3];
    expect(rawIcal).toContain('SUMMARY:Release ');
    expect(rawIcal).toContain('\r\n ');
    for (const line of rawIcal.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
  });

  it('uses DATE values for all-day events', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/calendar/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ calendarId: 'calendar-1', allDay: true, startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-09-02T00:00:00.000Z' }),
    });

    expect(response.status).toBe(201);
    expect(query.mock.calls[1][1][3]).toContain('DTSTART;VALUE=DATE:20260901');
    expect(query.mock.calls[1][1][3]).toContain('DTEND;VALUE=DATE:20260902');
  });

  it('rejects creation in a read-only imported calendar', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'caldav', read_only: true }] });

    const response = await fetch(`${base}/api/calendar/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1',
        summary: 'Read-only event',
        startsAt: '2026-09-01T09:00:00.000Z',
        endsAt: '2026-09-01T10:00:00.000Z',
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'This calendar is read-only' });
  });
  it('updates only events in a writable calendar owned by the signed-in user', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ uid: "uid-1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "event-1", calendar_id: "calendar-1", uid: "uid-1", etag: "etag-2", summary: "Updated" }] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/calendar/events/event-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1',
        summary: 'Updated',
        startsAt: '2026-09-01T11:00:00.000Z',
        endsAt: '2026-09-01T12:00:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).event).toMatchObject({ id: 'event-1', summary: 'Updated' });
    expect(query.mock.calls[2][0]).toContain("raw_ical = $1");
    expect(query.mock.calls[2][1][0]).toMatch(/^BEGIN:VCALENDAR\r\nVERSION:2.0\r\n/);
    expect(query.mock.calls[2][1][0]).toContain("UID:uid-1");
    expect(query.mock.calls[2][1][0]).toContain("SUMMARY:Updated");
    expect(query.mock.calls[2][1][0]).toContain("DTSTART:20260901T110000Z");
    expect(query.mock.calls[2][1]).toContain("event-1");
    expect(query.mock.calls[2][1]).toContain("user-1");
  });

  it('updates invitation metadata and sends changes with the existing event UID', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [sender] })
      .mockResolvedValueOnce({ rows: [{ uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-1', invitation_sequence: 0 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-1', invitation_sequence: 1 }] });

    const response = await fetch(`${base}/api/calendar/events/event-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: 'Updated', sendInvites: true, inviteAccountId: 'account-1', attendees: ['guest@example.test'],
        startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect(query.mock.calls[3][0]).toContain('invitation_sequence = CASE');
    expect(query.mock.calls[3][0]).toContain('invitation_sequence + 1');
    expect(query.mock.calls[3][0]).toContain('WHERE id = $13 AND calendar_id = $14 AND user_id = $15');
    expect(query.mock.calls[3][1]).toContainEqual(['guest@example.test']);
    expect(sendCalendarInvitation).toHaveBeenCalledWith(expect.objectContaining({ account: sender, attendees: ['guest@example.test'], uid: 'uid-1', method: 'REQUEST', sequence: 1 }));
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[2][0]).toContain('FOR UPDATE');
  });

  it('cancels a previously sent invitation when invitations are removed', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    const existingEvent = {
      uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-1', invitation_sequence: 2,
      summary: 'Planning', description: 'Original details', location: 'Room 1',
      starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false,
    };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [existingEvent] })
      .mockResolvedValueOnce({ rows: [sender] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', attendees: [], invite_account_id: null, invitation_sequence: 3 }] });

    const response = await fetch(`${base}/api/calendar/events/event-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: 'Planning', attendees: [], sendInvites: false,
        startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect(sendCalendarInvitation).toHaveBeenCalledWith(expect.objectContaining({
      account: sender, attendees: ['guest@example.test'], uid: 'uid-1', method: 'CANCEL', sequence: 3,
      startsAt: new Date('2026-09-01T09:00:00.000Z'), endsAt: new Date('2026-09-01T10:00:00.000Z'),
    }));
    expect(query.mock.calls[2][0]).not.toContain('enabled = true');
  });

  it('cancels attendees removed from an updated invitation', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [sender] })
      .mockResolvedValueOnce({ rows: [{
        uid: 'uid-1', attendees: ['kept@example.test', 'removed@example.test'], invite_account_id: 'account-1', invitation_sequence: 2,
        summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false,
      }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', uid: 'uid-1', attendees: ['kept@example.test'], invite_account_id: 'account-1', invitation_sequence: 3 }] });

    const response = await fetch(`${base}/api/calendar/events/event-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: 'Planning', sendInvites: true, inviteAccountId: 'account-1', attendees: ['kept@example.test'],
        startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect(sendCalendarInvitation).toHaveBeenNthCalledWith(1, expect.objectContaining({
      account: sender, attendees: ['removed@example.test'], method: 'CANCEL', sequence: 3,
    }));
    expect(sendCalendarInvitation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      account: sender, attendees: ['kept@example.test'], method: 'REQUEST', sequence: 3,
    }));
  });

  it('keeps the event unchanged when the previous invitation cannot be cancelled during an update', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    sendCalendarInvitation.mockRejectedValueOnce(new Error('SMTP unavailable'));
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{
        uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-1', invitation_sequence: 2,
        summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false,
      }] })
      .mockResolvedValueOnce({ rows: [sender] });

    const response = await fetch(`${base}/api/calendar/events/event-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: 'Changed', sendInvites: false, attendees: [],
        startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z',
      }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'The previous invitation could not be cancelled, so the event was not changed.' });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE calendar_events'))).toBe(false);
  });

  it('returns a cancellation failure for an idempotent update when the previous sender is unavailable', async () => {
    const newSender = { id: 'account-new', email_address: 'new@example.test', smtp_host: 'smtp.example.test', enabled: true };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [newSender] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-old', invitation_sequence: 2,
        summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false,
      }] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/calendar/events/event-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-idempotency-key': 'retry-1' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: 'Planning', sendInvites: true, inviteAccountId: 'account-new', attendees: ['guest@example.test'],
        startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z',
      }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'The previous invitation could not be cancelled, so the event was not changed.' });
    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE calendar_events'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => /(?:INSERT INTO|UPDATE) calendar_invitation_outbox/.test(sql))).toBe(false);
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
  });

  it('continues the iCalendar sequence when invitations are enabled again', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [sender] })
      .mockResolvedValueOnce({ rows: [{ uid: 'uid-1', attendees: [], invite_account_id: null, invitation_sequence: 3 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-1', invitation_sequence: 4 }] });

    const response = await fetch(`${base}/api/calendar/events/event-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: 'Planning', sendInvites: true, inviteAccountId: 'account-1', attendees: ['guest@example.test'],
        startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect(sendCalendarInvitation).toHaveBeenCalledWith(expect.objectContaining({ method: 'REQUEST', sequence: 4 }));
  });

  it('cancels the prior organizer invitation before changing sender accounts', async () => {
    const oldSender = { id: 'account-old', email_address: 'old@example.test', smtp_host: 'smtp.example.test', enabled: true };
    const newSender = { id: 'account-new', email_address: 'new@example.test', smtp_host: 'smtp.example.test', enabled: true };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [newSender] })
      .mockResolvedValueOnce({ rows: [{
        uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-old', invitation_sequence: 2,
        summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false,
      }] })
      .mockResolvedValueOnce({ rows: [oldSender] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-new', invitation_sequence: 3 }] });

    const response = await fetch(`${base}/api/calendar/events/event-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'calendar-1', summary: 'Planning', sendInvites: true, inviteAccountId: 'account-new', attendees: ['guest@example.test'],
        startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect(sendCalendarInvitation).toHaveBeenNthCalledWith(1, expect.objectContaining({ account: oldSender, method: 'CANCEL', sequence: 3 }));
    expect(sendCalendarInvitation).toHaveBeenNthCalledWith(2, expect.objectContaining({ account: newSender, method: 'REQUEST', sequence: 3 }));
  });

  it('refuses an event update with an invalid range before querying the database', async () => {
    const response = await fetch(`${base}/api/calendar/events/event-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ calendarId: 'calendar-1', startsAt: 'invalid', endsAt: '2026-09-01T12:00:00.000Z' }),
    });

    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects newline-injected attendees on update before querying the database', async () => {
    const response = await fetch(`${base}/api/calendar/events/event-1`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ calendarId: 'calendar-1', attendees: ['guest@example.test\r\nBcc: victim@example.test'], startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z' }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Attendees must be valid email addresses' });
    expect(query).not.toHaveBeenCalled();
  });

  it('deletes only an event from a writable calendar owned by the signed-in user', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] });

    const response = await fetch(`${base}/api/calendar/events/event-1?calendarId=calendar-1`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(query.mock.calls[2][0]).toContain('DELETE FROM calendar_events');
    expect(query.mock.calls[2][1]).toEqual(['event-1', 'calendar-1', 'user-1']);
  });

  it('cancels an invitation when deleting its event', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'event-1', uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-1', invitation_sequence: 2,
        summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false,
      }] })
      .mockResolvedValueOnce({ rows: [sender] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] });

    const response = await fetch(`${base}/api/calendar/events/event-1?calendarId=calendar-1`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(query.mock.calls[1][0]).toContain('SELECT uid, attendees, invite_account_id');
    expect(query.mock.calls[3][0]).toContain('DELETE FROM calendar_events');
    expect(sendCalendarInvitation).toHaveBeenCalledWith(expect.objectContaining({
      account: sender, attendees: ['guest@example.test'], uid: 'uid-1', method: 'CANCEL', sequence: 3,
    }));
    expect(query.mock.calls[2][0]).not.toContain('enabled = true');
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[1][0]).toContain('FOR UPDATE');
  });

  it('keeps an invited event when its cancellation cannot be delivered', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    sendCalendarInvitation.mockRejectedValueOnce(new Error('SMTP unavailable'));
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'event-1', uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-1', invitation_sequence: 2,
        summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false,
      }] })
      .mockResolvedValueOnce({ rows: [sender] });

    const response = await fetch(`${base}/api/calendar/events/event-1?calendarId=calendar-1`, { method: 'DELETE' });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'The invitation could not be cancelled, so the event was not deleted.' });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('persists an invitation outbox row for an idempotent send', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [sender] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', invitation_sequence: 0 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] })
      .mockResolvedValueOnce({ rows: [] });
    const response = await fetch(`${base}/api/calendar/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Idempotency-Key': 'invite-1' }, body: JSON.stringify({ calendarId: 'calendar-1', summary: 'Planning', sendInvites: true, inviteAccountId: 'account-1', attendees: ['guest@example.test'], startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z' }) });
    expect(response.status).toBe(201);
    expect(sendCalendarInvitation).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => sql.includes('calendar_invitation_outbox'))).toBe(true);
  });

  it('rolls back the event when the invitation outbox insert fails', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    query.mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] }).mockResolvedValueOnce({ rows: [sender] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'event-1', uid: 'uid-1' }] }).mockRejectedValueOnce(new Error('outbox unavailable'));
    const response = await fetch(`${base}/api/calendar/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Idempotency-Key': 'invite-rollback' }, body: JSON.stringify({ calendarId: 'calendar-1', sendInvites: true, inviteAccountId: 'account-1', attendees: ['guest@example.test'], startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z' }) });
    expect(response.status).toBe(500);
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
  });

  it('cancels removed attendees once and returns the same result for a duplicate idempotent update', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    const existing = { uid: 'uid-1', attendees: ['kept@example.test', 'removed@example.test'], invite_account_id: 'account-1', invitation_sequence: 2, summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false };
    const event = { id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', attendees: ['kept@example.test'], invite_account_id: 'account-1', invitation_sequence: 3 };
    let outbox;
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM calendars')) return { rows: [{ id: 'calendar-1', source: 'local', read_only: false }] };
      if (sql.includes('FROM email_accounts')) return { rows: [sender] };
      if (sql.includes('FROM calendar_invitation_outbox')) return { rows: outbox ? [outbox] : [] };
      if (sql.includes('FROM calendar_events') && sql.includes('FOR UPDATE')) return { rows: [existing] };
      if (sql.includes('FROM calendar_events')) return { rows: [event] };
      if (sql.includes('UPDATE calendar_events')) return { rows: [event] };
      if (sql.includes('INSERT INTO calendar_invitation_outbox')) { outbox = { id: 'outbox-1', event_id: 'event-1', request_fingerprint: params[3] }; return { rows: [{ id: 'outbox-1' }] }; }
      if (sql.includes('UPDATE calendar_invitation_outbox')) return { rows: [] };
      return { rows: [] };
    });
    const body = { calendarId: 'calendar-1', summary: 'Planning', sendInvites: true, inviteAccountId: 'account-1', attendees: ['kept@example.test'], startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z' };
    const first = await fetch(`${base}/api/calendar/events/event-1`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'X-Idempotency-Key': 'patch-1' }, body: JSON.stringify(body) });
    const second = await fetch(`${base}/api/calendar/events/event-1`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'X-Idempotency-Key': 'patch-1' }, body: JSON.stringify(body) });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(sendCalendarInvitation).toHaveBeenCalledTimes(2);
    expect(sendCalendarInvitation).toHaveBeenNthCalledWith(1, expect.objectContaining({ method: 'CANCEL', account: sender, attendees: ['removed@example.test'], sequence: 3 }));
    expect(sendCalendarInvitation).toHaveBeenNthCalledWith(2, expect.objectContaining({ method: 'REQUEST', account: sender, attendees: ['kept@example.test'], sequence: 3 }));
    expect(query.mock.calls.filter(([sql]) => sql.includes('UPDATE calendar_events')).length).toBe(1);
  });

  it('rejects reuse of an idempotency key for a different update target', async () => {
    const sender = { id: 'account-1', smtp_host: 'smtp.example.test', enabled: true };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [sender] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1', event_id: 'event-other', request_fingerprint: 'different' }] });
    const response = await fetch(`${base}/api/calendar/events/event-1`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'X-Idempotency-Key': 'same-key' }, body: JSON.stringify({ calendarId: 'calendar-1', sendInvites: true, inviteAccountId: 'account-1', attendees: ['guest@example.test'], startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z' }) });
    expect(response.status).toBe(409);
    expect(sendCalendarInvitation).not.toHaveBeenCalled();
  });

  it('returns durable failed delivery status for a duplicate idempotent POST without sending again', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    const event = { id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', invitation_sequence: 0 };
    let outbox;
    sendCalendarInvitation.mockRejectedValueOnce(new Error('SMTP unavailable'));
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM calendars')) return { rows: [{ id: 'calendar-1', source: 'local', read_only: false }] };
      if (sql.includes('FROM email_accounts')) return { rows: [sender] };
      if (sql.includes('FROM calendar_invitation_outbox')) return { rows: outbox ? [{ ...outbox, status: 'sending', last_error: 'SMTP unavailable' }] : [] };
      if (sql.includes('INSERT INTO calendar_events')) return { rows: [event] };
      if (sql.includes('INSERT INTO calendar_invitation_outbox')) { outbox = { id: 'outbox-1', event_id: event.id, request_fingerprint: params[3] }; return { rows: [{ id: 'outbox-1' }] }; }
      if (sql.includes('UPDATE calendar_invitation_outbox')) return { rows: [] };
      if (sql.includes('FROM calendar_events')) return { rows: [event] };
      return { rows: [] };
    });
    const body = { calendarId: 'calendar-1', summary: 'Planning', sendInvites: true, inviteAccountId: 'account-1', attendees: ['guest@example.test'], startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z' };

    const first = await fetch(`${base}/api/calendar/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Idempotency-Key': 'post-failed' }, body: JSON.stringify(body) });
    const second = await fetch(`${base}/api/calendar/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Idempotency-Key': 'post-failed' }, body: JSON.stringify(body) });

    expect(first.status).toBe(201);
    expect((await first.json()).invitationError).toContain('Retry the same save to check its delivery status');
    expect(second.status).toBe(201);
    expect(await second.json()).toMatchObject({ invitationError: expect.stringContaining('SMTP unavailable'), invitationStatus: { status: 'failed', lastError: 'SMTP unavailable' } });
    expect(sendCalendarInvitation).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO calendar_events')).length).toBe(1);
  });

  it('returns durable failed delivery status for a duplicate idempotent PATCH without sending again', async () => {
    const sender = { id: 'account-1', email_address: 'owner@example.test', smtp_host: 'smtp.example.test', enabled: true };
    const existing = { uid: 'uid-1', attendees: [], invite_account_id: null, invitation_sequence: 0, summary: 'Planning', starts_at: '2026-09-01T09:00:00.000Z', ends_at: '2026-09-01T10:00:00.000Z', all_day: false };
    const event = { id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', attendees: ['guest@example.test'], invite_account_id: 'account-1', invitation_sequence: 0 };
    let outbox;
    sendCalendarInvitation.mockRejectedValueOnce(new Error('SMTP unavailable'));
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM calendars')) return { rows: [{ id: 'calendar-1', source: 'local', read_only: false }] };
      if (sql.includes('FROM email_accounts')) return { rows: [sender] };
      if (sql.includes('FROM calendar_invitation_outbox')) return { rows: outbox ? [{ ...outbox, status: 'sending', last_error: 'SMTP unavailable' }] : [] };
      if (sql.includes('FOR UPDATE')) return { rows: [existing] };
      if (sql.includes('UPDATE calendar_events')) return { rows: [event] };
      if (sql.includes('INSERT INTO calendar_invitation_outbox')) { outbox = { id: 'outbox-1', event_id: event.id, request_fingerprint: params[3] }; return { rows: [{ id: 'outbox-1' }] }; }
      if (sql.includes('UPDATE calendar_invitation_outbox')) return { rows: [] };
      if (sql.includes('FROM calendar_events')) return { rows: [event] };
      return { rows: [] };
    });
    const body = { calendarId: 'calendar-1', summary: 'Planning', sendInvites: true, inviteAccountId: 'account-1', attendees: ['guest@example.test'], startsAt: '2026-09-01T11:00:00.000Z', endsAt: '2026-09-01T12:00:00.000Z' };

    const first = await fetch(`${base}/api/calendar/events/event-1`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'X-Idempotency-Key': 'patch-failed' }, body: JSON.stringify(body) });
    const second = await fetch(`${base}/api/calendar/events/event-1`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'X-Idempotency-Key': 'patch-failed' }, body: JSON.stringify(body) });

    expect(first.status).toBe(200);
    expect((await first.json()).invitationError).toContain('Retry the same save to check its delivery status');
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ invitationError: expect.stringContaining('SMTP unavailable'), invitationStatus: { status: 'failed', lastError: 'SMTP unavailable' } });
    expect(sendCalendarInvitation).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.filter(([sql]) => sql.includes('UPDATE calendar_events')).length).toBe(1);
  });

});
