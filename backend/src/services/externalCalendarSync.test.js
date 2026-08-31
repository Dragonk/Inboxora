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
    expect(query.mock.calls[3][0]).toContain('INSERT INTO calendar_events');
    expect(query.mock.calls[3][1]).toContain('event-1');
    expect(query.mock.calls[4][0]).toContain('DELETE FROM calendar_events');
    expect(query.mock.calls[4][1]).toEqual(['calendar-1', ['event-1']]);
  });

  it('keeps the prior projection when a non-empty ICS response has no supported events', async () => {
    query.mockResolvedValueOnce({ rows: [source] }).mockResolvedValueOnce({ rows: [] });
    safeFetch.mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:broken\r\nEND:VEVENT\r\nEND:VCALENDAR') });

    const result = await syncCalendarSource('user-1', 'source-1');

    expect(result).toEqual({ ok: false, error: 'Remote calendar contains an unsupported event' });
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
