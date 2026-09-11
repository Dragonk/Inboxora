// Reading a calendar invitation out of a received message. The card in the reader
// could not open or import an invitation ("Nie udało się odczytać lub zapisać
// zaproszenia") because the .ics MIME part was handed over still base64-encoded.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import 'express-async-errors';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../services/db.js', () => ({ query, withTransaction: vi.fn(async (fn) => fn({ query })) }));
vi.mock('../services/encryption.js', () => ({ encrypt: (value) => `enc:${value}`, decrypt: (value) => value }));
vi.mock('../services/calendarInvitation.js', () => ({ sendCalendarInvitation: vi.fn() }));
vi.mock('../services/externalCalendarSync.js', () => ({ releaseCalendarSource: vi.fn(), scheduleCalendarSource: vi.fn(), stopCalendarSource: vi.fn(), syncCalendarSource: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); } }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: false })) }));

// The route reaches the mailbox through the running server module, which must never
// be imported for real in a unit test.
const { imapManager } = vi.hoisted(() => ({ imapManager: { fetchAttachment: vi.fn() } }));
vi.mock('../index.js', () => ({ imapManager }));

import express from 'express';
import calendarRouter from './calendar.js';

const MESSAGE_ID = '503d6b49-2095-4e97-8e59-0cb643e71539';
const ACCOUNT_ID = 'c9f370a0-936e-4c22-8b8b-20952ffcf1e1';

// Exactly the iCalendar this app emails out (and what a mail client delivers).
const INVITATION = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Inboxora//Calendar//EN', 'METHOD:REQUEST',
  'BEGIN:VEVENT', 'UID:5f49e131-290f-4f27-88d2-3406d72725a5', 'SEQUENCE:0',
  'DTSTAMP:20260911T120000Z', 'DTSTART:20260911T130000Z', 'DTEND:20260911T140000Z',
  'ORGANIZER:mailto:kmaciag93@gmail.com', 'SUMMARY:Testowe wydarzenie',
  'DESCRIPTION:Agenda', 'LOCATION:Sala 1',
  'ATTENDEE;ROLE=REQ-PARTICIPANT:mailto:admin@kmms.ovh',
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

const MESSAGE_ROW = {
  raw_ical: null,
  account_id: ACCOUNT_ID,
  uid: 42,
  folder: 'INBOX',
  attachments: JSON.stringify([{ part: '2', filename: 'invitation.ics', type: 'text/calendar', size: 676 }]),
};

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
  imapManager.fetchAttachment.mockReset();
});

describe('GET /api/calendar/invitations/:messageId', () => {
  it('opens an invitation whose captured raw_ical is missing, using the decoded attachment', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM messages')) return { rows: [MESSAGE_ROW] };
      if (sql.includes('FROM email_accounts')) return { rows: [{ id: ACCOUNT_ID, imap_host: 'imap.example.test' }] };
      return { rows: [] };
    });
    // The mailbox returns the decoded bytes of the part.
    imapManager.fetchAttachment.mockResolvedValue(Buffer.from(INVITATION, 'utf8'));

    const response = await fetch(`${base}/api/calendar/invitations/${MESSAGE_ID}`);
    expect(response.status).toBe(200);
    const { invitation } = await response.json();
    expect(invitation).toMatchObject({
      method: 'REQUEST',
      uid: '5f49e131-290f-4f27-88d2-3406d72725a5',
      summary: 'Testowe wydarzenie',
      organizer: 'mailto:kmaciag93@gmail.com',
      location: 'Sala 1',
      description: 'Agenda',
    });
    expect(invitation.startsAt).toBe('2026-09-11T13:00:00.000Z');
    // It is fetched exactly once, with the part the attachment list advertises.
    expect(imapManager.fetchAttachment).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT_ID }), 42, 'INBOX', '2');
  });

  it('falls back to the attachment when the captured raw_ical cannot be parsed', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM messages')) return { rows: [{ ...MESSAGE_ROW, raw_ical: 'not an invitation' }] };
      if (sql.includes('FROM email_accounts')) return { rows: [{ id: ACCOUNT_ID }] };
      return { rows: [] };
    });
    imapManager.fetchAttachment.mockResolvedValue(Buffer.from(INVITATION, 'utf8'));

    const response = await fetch(`${base}/api/calendar/invitations/${MESSAGE_ID}`);
    expect(response.status).toBe(200);
    expect((await response.json()).invitation.summary).toBe('Testowe wydarzenie');
  });

  it('prefers the captured invitation and never opens the mailbox when it parses', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM messages')) return { rows: [{ ...MESSAGE_ROW, raw_ical: INVITATION }] };
      return { rows: [] };
    });

    const response = await fetch(`${base}/api/calendar/invitations/${MESSAGE_ID}`);
    expect(response.status).toBe(200);
    expect(imapManager.fetchAttachment).not.toHaveBeenCalled();
  });

  it('reports a missing invitation instead of failing when the mailbox is unreachable', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM messages')) return { rows: [MESSAGE_ROW] };
      if (sql.includes('FROM email_accounts')) return { rows: [{ id: ACCOUNT_ID }] };
      return { rows: [] };
    });
    imapManager.fetchAttachment.mockRejectedValue(new Error('connect ECONNREFUSED'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await fetch(`${base}/api/calendar/invitations/${MESSAGE_ID}`);
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Calendar invitation not found');
  });

  it('imports the invitation into the chosen calendar', async () => {
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM calendars')) return { rows: [{ id: 'calendar-1', source: 'local', read_only: false }] };
      if (sql.includes('FROM messages')) return { rows: [{ ...MESSAGE_ROW, raw_ical: INVITATION }] };
      if (sql.includes('INSERT INTO calendar_events')) return { rows: [{ id: 'event-1' }] };
      void params;
      return { rows: [] };
    });

    const response = await fetch(`${base}/api/calendar/invitations/${MESSAGE_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ calendarId: 'calendar-1' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ added: true, changed: true });

    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO calendar_events'));
    const insertParams = insert[1];
    // A local copy is namespaced and must not collide with the organizer's UID.
    expect(insertParams[2]).toMatch(/^mail-[0-9a-f]{64}$/);
    expect(insertParams[4]).toBe('Testowe wydarzenie');
    expect(insertParams[9]).toBe('Agenda');
    // attendees is jsonb: bound as JSON, never as a PostgreSQL array literal.
    expect(insertParams[13]).toBe(JSON.stringify(['admin@kmms.ovh']));
    // The event remembers the message it came from, so the calendar can link back.
    expect(insertParams[15]).toBe(MESSAGE_ID);
  });
});
