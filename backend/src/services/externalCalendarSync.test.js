import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, safeFetch, getConnectionPolicy } = vi.hoisted(() => ({
  query: vi.fn(), safeFetch: vi.fn(), getConnectionPolicy: vi.fn(),
}));
vi.mock('./db.js', () => ({ query }));
vi.mock('./safeFetch.js', () => ({ safeFetch }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy }));
vi.mock('./encryption.js', () => ({ decrypt: (value) => value }));

import { syncCalendarSource } from './externalCalendarSync.js';

const source = {
  id: 'source-1', user_id: 'user-1', kind: 'ical_url', url: 'https://calendar.example/events.ics',
  display_name: 'Holiday calendar', color: null, interval_min: 60, enabled: true,
};
const ical = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:event-1\r\nDTSTART:20260901T090000Z\r\nDTEND:20260901T100000Z\r\nSUMMARY:Planning\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

describe('external calendar imports', () => {
  beforeEach(() => {
    query.mockReset(); safeFetch.mockReset(); getConnectionPolicy.mockReset();
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false });
  });

  it('pulls an ICS source into a read-only calendar and removes stale imported events', async () => {
    query
      .mockResolvedValueOnce({ rows: [source] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    safeFetch.mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue(ical) });

    const result = await syncCalendarSource('user-1', 'source-1');

    expect(result).toEqual({ ok: true, eventCount: 1 });
    expect(safeFetch).toHaveBeenCalledWith(source.url, expect.objectContaining({ headers: { Accept: 'text/calendar' } }), { allowPrivate: false });
    expect(query.mock.calls[2][1]).toEqual(['user-1', 'Holiday calendar', null, 'ical_url', 'source:source-1']);
    const eventInsert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO calendar_events'));
    const staleDelete = query.mock.calls.find(([sql]) => sql.includes('DELETE FROM calendar_events'));
    expect(eventInsert?.[1]).toContain('event-1');
    expect(staleDelete?.[1]).toEqual(['calendar-1', ['event-1']]);
  });

  it('imports a recurring VEVENT without discarding its VCALENDAR context or non-event siblings', async () => {
    const richIcal = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Berlin\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:weekly-planning\r\nDTSTART;TZID=Europe/Berlin:20260901T090000\r\nDURATION:PT1H\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nATTENDEE;CN=Sam:mailto:sam@example.test\r\nATTENDEE;CN=Taylor:mailto:taylor@example.test\r\nX-INBOXORA-EXAMPLE:kept\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\nEND:VEVENT\r\nBEGIN:VTODO\r\nUID:todo-1\r\nSUMMARY:Not an event projection\r\nEND:VTODO\r\nBEGIN:VJOURNAL\r\nUID:journal-1\r\nEND:VJOURNAL\r\nBEGIN:VFREEBUSY\r\nUID:freebusy-1\r\nEND:VFREEBUSY\r\nEND:VCALENDAR\r\n';
    query
      .mockResolvedValueOnce({ rows: [source] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    safeFetch.mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue(richIcal) });

    const result = await syncCalendarSource('user-1', 'source-1');

    expect(result).toEqual({ ok: true, eventCount: 1 });
    const eventInsert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO calendar_events'));
    const storedRaw = eventInsert?.[1][3];
    expect(storedRaw).toContain('BEGIN:VTIMEZONE');
    expect(storedRaw).toContain('RRULE:FREQ=WEEKLY;COUNT=4');
    expect(storedRaw).toContain('ATTENDEE;CN=Sam:mailto:sam@example.test');
    expect(storedRaw).toContain('BEGIN:VALARM');
    expect(storedRaw).toContain('X-INBOXORA-EXAMPLE:kept');
    expect(storedRaw).not.toContain('BEGIN:VTODO');
    const storedDocument = query.mock.calls.find(([sql]) => sql.includes('calendar_import_documents'));
    expect(storedDocument?.[1]).toEqual(['source-1', richIcal]);
    expect(query.mock.calls.at(-1)[0]).toContain('last_error = NULL');
    expect(query.mock.calls.at(-1)[1]).toEqual(['source-1']);
  });

  it('imports a valid legacy ICS feed that uses bare CR line endings', async () => {
    const crOnly = 'BEGIN:VCALENDAR\rVERSION:2.0\rBEGIN:VEVENT\rUID:cr-only\rDTSTART:20260901T090000Z\rDTEND:20260901T100000Z\rEND:VEVENT\rEND:VCALENDAR\r';
    query
      .mockResolvedValueOnce({ rows: [source] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'calendar-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    safeFetch.mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue(crOnly) });

    const result = await syncCalendarSource('user-1', 'source-1');

    expect(result).toEqual({ ok: true, eventCount: 1 });
    const eventInsert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO calendar_events'));
    expect(eventInsert?.[1][3]).toContain('UID:cr-only\r');
  });

  it('keeps the prior projection when a non-empty ICS response has no supported events', async () => {
    query.mockResolvedValueOnce({ rows: [source] }).mockResolvedValueOnce({ rows: [] });
    safeFetch.mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:broken\r\nEND:VEVENT\r\nEND:VCALENDAR') });

    const result = await syncCalendarSource('user-1', 'source-1');

    expect(result).toEqual({ ok: false, error: 'Remote calendar contains an unsupported event' });
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM calendar_events'))).toBe(false);
  });

  it('keeps the prior projection when an ICS source returns an empty body', async () => {
    query.mockResolvedValueOnce({ rows: [source] }).mockImplementation(async (sql) => (
      sql.includes('INSERT INTO calendars') ? { rows: [{ id: 'calendar-1' }] } : { rows: [] }
    ));
    safeFetch.mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue('   \r\n\t') });

    const result = await syncCalendarSource('user-1', 'source-1');

    expect(result).toEqual({ ok: false, error: 'Remote calendar did not contain any VEVENT components' });
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM calendar_events'))).toBe(false);
  });

  it('records a source-specific failure instead of throwing and does not import partial data', async () => {
    query.mockResolvedValueOnce({ rows: [source] }).mockResolvedValueOnce({ rows: [] });
    safeFetch.mockRejectedValue(new Error('network unavailable'));

    const result = await syncCalendarSource('user-1', 'source-1');

    expect(result).toEqual({ ok: false, error: 'network unavailable' });
    expect(query.mock.calls[1][0]).toContain('last_error');
    expect(query.mock.calls[1][1]).toEqual(['source-1', 'network unavailable']);
  });
});
