import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

const { query, safeFetch, getConnectionPolicy } = vi.hoisted(() => ({
  query: vi.fn(), safeFetch: vi.fn(), getConnectionPolicy: vi.fn(),
}));
vi.mock('./db.js', () => ({ query }));
vi.mock('./safeFetch.js', () => ({ safeFetch }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy }));
vi.mock('./encryption.js', () => ({ decrypt: (value) => value?.startsWith('enc:v1:') ? value.slice('enc:v1:'.length) : value }));

import { stopCalendarSource, syncCalendarSource } from './externalCalendarSync.js';

const source = {
  id: 'source-1', user_id: 'user-1', kind: 'ical_url', url: 'enc:v1:https://calendar.example/events.ics',
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
    expect(safeFetch).toHaveBeenCalledWith('https://calendar.example/events.ics', expect.objectContaining({ headers: { Accept: 'text/calendar' } }), { allowPrivate: false });
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

  it('imports an all-day DATE event without DTEND as a one-day event', async () => {
    const fixture = await readFile(new URL('./fixtures/remote-calendar-all-day-no-end.ics', import.meta.url), 'utf8');
    query.mockResolvedValueOnce({ rows: [source] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'calendar-1' }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    safeFetch.mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue(fixture) });
    const result = await syncCalendarSource('user-1', 'source-1');
    expect(result).toEqual({ ok: true, eventCount: 1 });
    const eventInsert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO calendar_events'));
    expect(eventInsert?.[1]).toEqual(expect.arrayContaining(['all-day-no-end', true, new Date('2026-09-01T00:00:00.000Z'), new Date('2026-09-02T00:00:00.000Z')]));
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

  it('imports valid events while retaining skipped UIDs and reporting a warning', async () => {
    const mixedIcal = [ical, 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:broken-event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'].join('');
    query.mockResolvedValueOnce({ rows: [source] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'calendar-1' }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    safeFetch.mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue(mixedIcal) });
    const result = await syncCalendarSource('user-1', 'source-1');
    expect(result).toEqual({ ok: true, eventCount: 1, skipped: [{ uid: 'broken-event', reason: 'unsupported or malformed VEVENT' }] });
    const staleDelete = query.mock.calls.find(([sql]) => sql.includes('DELETE FROM calendar_events'));
    expect(staleDelete?.[1]).toEqual(['calendar-1', ['event-1', 'broken-event']]);
    expect(query.mock.calls.at(-1)[1]).toEqual(['source-1', 'broken-event: unsupported or malformed VEVENT']);
  });

  it('records a source-specific failure instead of throwing and does not import partial data', async () => {
    query.mockResolvedValueOnce({ rows: [source] }).mockResolvedValueOnce({ rows: [] });
    safeFetch.mockRejectedValue(new Error(`request failed for ${'https://calendar.example/events.ics'} (${source.url})`));

    const result = await syncCalendarSource('user-1', 'source-1');

    expect(result).toEqual({ ok: false, error: 'request failed for [redacted] ([redacted])' });
    expect(query.mock.calls[1][0]).toContain('last_error');
    expect(query.mock.calls[1][1]).toEqual(['source-1', 'request failed for [redacted] ([redacted])']);
  });

  it('aborts an in-flight fetch when the source is stopped without persisting removal as an error', async () => {
    query.mockResolvedValueOnce({ rows: [source] }).mockResolvedValue({ rows: [] });
    safeFetch.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));

    const sync = syncCalendarSource('user-1', 'source-1');
    await new Promise((resolve) => setImmediate(resolve));
    await expect(Promise.race([
      stopCalendarSource('source-1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('stop timed out')), 100)),
    ])).resolves.toBeUndefined();

    await expect(sync).resolves.toEqual({ ok: false, error: 'Calendar source removed' });
    expect(query.mock.calls.slice(2).some(([sql]) => /INSERT|UPDATE|DELETE/i.test(sql))).toBe(false);
  });
});
