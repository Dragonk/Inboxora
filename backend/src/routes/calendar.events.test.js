// Event-listing behaviour for the calendar endpoint: calendar selection stays
// scoped to the owner, an explicit empty selection means "none", and an
// incomplete projection is reported rather than silently shortened.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import 'express-async-errors';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../services/db.js', () => ({ query, withTransaction: vi.fn(async (fn) => fn({ query })) }));
vi.mock('../services/encryption.js', () => ({ encrypt: (value) => `enc:${value}`, decrypt: (value) => value, }));
vi.mock('../services/calendarInvitation.js', () => ({ sendCalendarInvitation: vi.fn() }));
vi.mock('../services/externalCalendarSync.js', () => ({ releaseCalendarSource: vi.fn(), scheduleCalendarSource: vi.fn(), stopCalendarSource: vi.fn(), syncCalendarSource: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); } }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: false })) }));

import express from 'express';
import calendarRouter from './calendar.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/calendar', calendarRouter);
  app.use((error, _req, res, next) => { void next; return res.status(500).json({ error: error.message }); });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

const RANGE = 'from=2026-09-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z';
const calendarId = '11111111-1111-4111-8111-111111111111';

describe('GET /api/calendar/events calendar selection', () => {
  it('keeps the owner scope on every query', async () => {
    await fetch(`${base}/api/calendar/events?${RANGE}`);
    const eventQuery = query.mock.calls.find(([sql]) => sql.includes('FROM calendar_events'));
    expect(eventQuery[0]).toContain('e.user_id = $1 AND c.user_id = $1 AND c.owner_user_id = $1');
    expect(eventQuery[1][0]).toBe('user-1');
  });

  it('adds a parameterised calendar filter only when a selection is supplied', async () => {
    await fetch(`${base}/api/calendar/events?${RANGE}`);
    const unfiltered = query.mock.calls.find(([sql]) => sql.includes('FROM calendar_events'));
    expect(unfiltered[0]).not.toContain('ANY($4::uuid[])');

    query.mockClear();
    await fetch(`${base}/api/calendar/events?${RANGE}&calendarIds=${calendarId}`);
    const filtered = query.mock.calls.find(([sql]) => sql.includes('FROM calendar_events'));
    expect(filtered[0]).toContain('c.id = ANY($4::uuid[])');
    expect(filtered[1][3]).toEqual([calendarId]);
  });

  it('treats an explicitly empty selection as no calendars at all', async () => {
    const response = await fetch(`${base}/api/calendar/events?${RANGE}&calendarIds=`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [], truncated: false });
    // No event query at all: an empty selection cannot match a calendar.
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM calendar_events'))).toBe(false);
  });

  it('skips the event query when only the contact calendar is selected', async () => {
    const response = await fetch(`${base}/api/calendar/events?${RANGE}&calendarIds=contacts-birthdays`);
    expect(response.status).toBe(200);
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM calendar_events'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM contacts'))).toBe(true);
  });

  it('rejects a malformed calendar id before touching the database', async () => {
    const response = await fetch(`${base}/api/calendar/events?${RANGE}&calendarIds=not-a-uuid`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid calendar id' });
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts a comma-separated selection and de-duplicates it', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    await fetch(`${base}/api/calendar/events?${RANGE}&calendarIds=${calendarId},${other},${calendarId}`);
    const filtered = query.mock.calls.find(([sql]) => sql.includes('FROM calendar_events'));
    expect(filtered[1][3]).toEqual([calendarId, other]);
  });

  it('finds recurring series through the indexed column, never a regex over raw_ical', async () => {
    await fetch(`${base}/api/calendar/events?${RANGE}`);
    const eventQuery = query.mock.calls.find(([sql]) => sql.includes('FROM calendar_events'));
    // The recurring half of "in this window, or a series" decides whether the planner can
    // use an index at all. As a regex over an unindexed TEXT column it could not, so every
    // event the user owned was scanned and its raw_ical detoasted — measured at 131 ms
    // against 3 ms on 20k events. `recurring` is maintained by a trigger (migration 0082).
    expect(eventQuery[0]).toContain('OR e.recurring');
    expect(eventQuery[0]).not.toMatch(/raw_ical\s*~\*/);
  });

  it('resolves the source message of a mail invitation only for its own account', async () => {
    await fetch(`${base}/api/calendar/events?${RANGE}`);
    // The read path has two queries now — materialised occurrences and the live fallback — and
    // both expose the mail link, so both must carry the tenant-safe join. Checking only the
    // first match would let a regression through in whichever one moved.
    const eventQueries = query.mock.calls.filter(([sql]) => sql.includes('FROM calendar_events'));
    expect(eventQueries.length).toBeGreaterThan(0);
    for (const [sql] of eventQueries) {
      // The link back to the original mail must not be able to cross tenants, and it
      // must disappear when the message is gone instead of pointing at a dead id.
      expect(sql).toContain('LEFT JOIN messages sm ON sm.id = e.source_message_id');
      expect(sql).toContain('LEFT JOIN email_accounts sa ON sa.id = sm.account_id AND sa.user_id = e.user_id');
      expect(sql).toContain('CASE WHEN sa.id IS NOT NULL THEN e.source_message_id END AS source_message_id');
    }
  });

  it('exposes the source message folder and account so the reader can be opened', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM calendar_events')) {
        return { rows: [{
          id: 'row-mail', calendar_id: calendarId, uid: 'mail-1', etag: 'etag-1',
          raw_ical: ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:mail-1', 'DTSTAMP:20260901T000000Z',
            'DTSTART:20260910T090000Z', 'DTEND:20260910T100000Z', 'SUMMARY:Z zaproszenia', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'),
          summary: 'Z zaproszenia', starts_at: new Date('2026-09-10T09:00:00Z'), ends_at: new Date('2026-09-10T10:00:00Z'),
          all_day: false, attendees: [], source_message_id: 'copy-1', source_folder: 'INBOX', source_account_id: 'account-1',
          calendar_name: 'Prywatny', calendar_color: '#4b75ff', source: 'local', read_only: false,
        }] };
      }
      return { rows: [] };
    });

    const response = await fetch(`${base}/api/calendar/events?${RANGE}`);
    const { events } = await response.json();
    expect(events[0]).toMatchObject({
      summary: 'Z zaproszenia', source_message_id: 'copy-1', source_folder: 'INBOX', source_account_id: 'account-1',
    });
  });
});

describe('GET /api/calendar/events projection outcome', () => {
  it('reports a complete result with an explicit truncated:false', async () => {
    const response = await fetch(`${base}/api/calendar/events?${RANGE}`);
    expect(await response.json()).toEqual({ events: [], truncated: false });
  });

  it('reports an incomplete series without leaking internal error text', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM calendar_events')) {
        return { rows: [{
          id: 'row-dense', calendar_id: calendarId, uid: 'dense', etag: 'etag-1',
          raw_ical: ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:dense', 'DTSTAMP:20200101T000000Z',
            'DTSTART:19700101T000000Z', 'DTEND:19700101T000100Z', 'RRULE:FREQ=MINUTELY', 'SUMMARY:Dense', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'),
          summary: 'Dense', starts_at: new Date('1970-01-01T00:00:00Z'), ends_at: new Date('1970-01-01T00:01:00Z'), all_day: false,
        }] };
      }
      return { rows: [] };
    });
    const previous = process.env.CALENDAR_PROJECTION_MAX_ITERATIONS;
    process.env.CALENDAR_PROJECTION_MAX_ITERATIONS = '500';
    try {
      const response = await fetch(`${base}/api/calendar/events?${RANGE}`);
      const payload = await response.json();
      expect(response.status).toBe(200);
      expect(payload.truncated).toBe(true);
      expect(payload.incompleteSeries).toEqual([{ series_id: 'row-dense', reason: 'iteration-limit' }]);
      // The marker is present and stable; no stack trace or SQL detail is exposed.
      expect(JSON.stringify(payload)).not.toMatch(/stack|at Object|SELECT|FROM calendar_events/);
    } finally {
      if (previous === undefined) delete process.env.CALENDAR_PROJECTION_MAX_ITERATIONS;
      else process.env.CALENDAR_PROJECTION_MAX_ITERATIONS = previous;
    }
  });
});
