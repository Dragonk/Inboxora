import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../services/db.js', () => ({
  query: mocks.query,
  withTransaction: async (fn: (client: { query: typeof mocks.query }) => unknown) => fn({ query: mocks.query }),
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { session?: { userId?: string } }, _res: unknown, next: () => void) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../services/calendarInvitation.js', () => ({ sendCalendarInvitation: vi.fn(), prepareCalendarInvitation: vi.fn() }));
vi.mock('../services/externalCalendarSync.js', () => ({
  releaseCalendarSource: vi.fn(), scheduleCalendarSource: vi.fn(), stopCalendarSource: vi.fn(), syncCalendarSource: vi.fn(),
}));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: false })) }));
vi.mock('../services/inboundCalendarInvitation.js', () => ({ parseInboundCalendarInvitation: vi.fn() }));

import calendarRouter from './calendar.js';

let server: Server;
let base = '';

const EVENT = (uid: string, summary: string, start: string, end: string) => [
  'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260801T000000Z',
  `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${summary}`,
  'LOCATION:Room 1', 'END:VEVENT',
].join('\r\n');

const wrap = (...events: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR', ''].join('\r\n');

const importIcs = (body: unknown) => fetch(`${base}/api/calendar/calendars/cal-1/import/ics`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

const queryCallsMatching = (fragment: string): unknown[][] =>
  mocks.query.mock.calls.filter(([sql]) => String(sql).includes(fragment));

beforeAll(async () => {
  const app = express();
  // The server's global JSON limit; the route's own guard rejects an oversized file.
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/calendar', calendarRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  mocks.query.mockReset();
  mocks.query.mockImplementation(async (sql: string) => (
    String(sql).includes('FROM calendars')
      ? { rows: [{ id: 'cal-1', source: 'local' }], rowCount: 1 }
      : { rows: [], rowCount: 1 }
  ));
});

describe('POST /api/calendar/calendars/:id/import/ics', () => {
  it('imports every event, keyed on the UID so a re-import updates', async () => {
    const response = await importIcs({
      ics: wrap(EVENT('e1', 'Standup', '20260901T090000Z', '20260901T100000Z'), EVENT('e2', 'Dentist', '20260910T150000Z', '20260910T160000Z')),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ imported: 2 });

    const inserts = queryCallsMatching('INSERT INTO calendar_events');
    expect(inserts).toHaveLength(2);
    expect(String(inserts[0][0])).toContain('ON CONFLICT (calendar_id, uid, recurrence_id) DO UPDATE');
    expect(inserts.map(call => (call[1] as unknown[])[2])).toEqual(['e1', 'e2']);
    // The parsed fields are projected, and the raw text is stored for the projection.
    const params = inserts[0][1] as unknown[];
    expect(params[5]).toBe('Standup');
    expect(params[11]).toBe('Room 1');
    expect(String(params[3])).toContain('UID:e1');
    // The collection's DAV sync token is maintained by the calendar_events trigger, so
    // the route must not write a second, differently shaped token of its own.
    expect(queryCallsMatching('UPDATE calendars SET sync_token')).toHaveLength(0);
  });

  it('keeps a series and its override in one resource, as DAV requires', async () => {
    const master = [
      'BEGIN:VEVENT', 'UID:series-1', 'DTSTAMP:20260801T000000Z', 'DTSTART:20260901T090000Z',
      'DTEND:20260901T093000Z', 'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:Standup', 'END:VEVENT',
    ].join('\r\n');
    const override = [
      'BEGIN:VEVENT', 'UID:series-1', 'DTSTAMP:20260801T000000Z', 'RECURRENCE-ID:20260915T090000Z',
      'DTSTART:20260916T110000Z', 'DTEND:20260916T120000Z', 'SUMMARY:Standup (moved)', 'END:VEVENT',
    ].join('\r\n');

    const response = await importIcs({ ics: wrap(master, override) });
    expect(response.status).toBe(201);
    // One import for the UID, not two: splitting them would break the series.
    expect(await response.json()).toEqual({ imported: 1 });
    const [insert] = queryCallsMatching('INSERT INTO calendar_events');
    const raw = String((insert?.[1] as unknown[])[3]);
    expect(raw).toContain('RRULE:FREQ=WEEKLY;COUNT=4');
    expect(raw).toContain('RECURRENCE-ID:20260915T090000Z');
  });

  it('rejects a file that is not an iCalendar document', async () => {
    const response = await importIcs({ ics: 'this is not a calendar' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'The file is not a valid iCalendar document' });
    expect(queryCallsMatching('INSERT INTO calendar_events')).toHaveLength(0);
  });

  it('skips an event the projection cannot read instead of storing it broken', async () => {
    // An event whose end precedes its start is invalid; it must not be imported and
    // must not stop the valid one beside it.
    const broken = EVENT('broken', 'Backwards', '20260901T090000Z', '20260901T080000Z');
    const good = EVENT('good', 'Fine', '20260902T090000Z', '20260902T100000Z');
    const response = await importIcs({ ics: wrap(broken, good) });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ imported: 1 });
    expect((queryCallsMatching('INSERT INTO calendar_events')[0]?.[1] as unknown[])[2]).toBe('good');
  });

  it('reports a valid document that contains no event', async () => {
    const response = await importIcs({ ics: wrap() });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'No events found in the file' });
  });

  it('rejects an empty or oversized body before looking the calendar up', async () => {
    expect((await importIcs({ ics: '' })).status).toBe(400);
    expect((await importIcs({ ics: 'x'.repeat(900_001) })).status).toBe(400);
    expect(queryCallsMatching('FROM calendars')).toHaveLength(0);
  });

  it('refuses to import into a calendar that its source owns', async () => {
    mocks.query.mockImplementation(async (sql: string) => (
      String(sql).includes('FROM calendars')
        ? { rows: [{ id: 'cal-1', source: 'google' }], rowCount: 1 }
        : { rows: [], rowCount: 1 }
    ));
    const response = await importIcs({ ics: wrap(EVENT('e1', 'Standup', '20260901T090000Z', '20260901T100000Z')) });
    expect(response.status).toBe(403);
    expect(queryCallsMatching('INSERT INTO calendar_events')).toHaveLength(0);
  });
});
