import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../services/db.js', () => ({ query }));
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

beforeEach(() => query.mockReset());

describe('local calendar API', () => {
  it('lists only calendars owned by the signed-in user', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'calendar-1', name: 'Personal', source: 'local', read_only: false }] });

    const response = await fetch(`${base}/api/calendar/calendars`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ calendars: [{ id: 'calendar-1', name: 'Personal', source: 'local', read_only: false }] });
    expect(query.mock.calls[0][0]).toContain('WHERE user_id = $1');
    expect(query.mock.calls[0][1]).toEqual(['user-1']);
  });

  it('rejects an excessively broad event range before querying the database', async () => {
    const response = await fetch(`${base}/api/calendar/events?from=2026-01-01T00:00:00.000Z&to=2028-01-02T00:00:00.000Z`);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'The requested event range is too large' });
    expect(query).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', calendar_id: 'calendar-1', uid: 'uid-1', etag: 'etag-2', summary: 'Updated' }] })
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
    expect(query.mock.calls[1][0]).toContain('WHERE id = $10 AND calendar_id = $11 AND user_id = $12');
    expect(query.mock.calls[1][1]).toContain('event-1');
    expect(query.mock.calls[1][1]).toContain('user-1');
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

  it('deletes only an event from a writable calendar owned by the signed-in user', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1', source: 'local', read_only: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/calendar/events/event-1?calendarId=calendar-1`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(query.mock.calls[1][0]).toContain('WHERE id = $1 AND calendar_id = $2 AND user_id = $3');
    expect(query.mock.calls[1][1]).toEqual(['event-1', 'calendar-1', 'user-1']);
  });

});
