import { describe, expect, it, vi } from 'vitest';
import { persistInboundCalendarInvitation } from './inboundCalendarInvitationPersistence.js';

const invitation = {
  method: 'REQUEST', state: 'pending', uid: 'meeting-123', recurrenceId: '', sequence: 2,
  summary: 'Planning', organizer: 'mailto:taylor@example.test', startsAt: new Date('2026-09-08T09:00:00.000Z'),
  endsAt: new Date('2026-09-08T10:00:00.000Z'), allDay: false, timeZone: 'Europe/Berlin', raw: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR',
};

describe('persistInboundCalendarInvitation', () => {
  it('upserts one projection for a physical message row and replaces stale parsed fields', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });

    await persistInboundCalendarInvitation({ query, messageId: '4b7b090d-ec0f-4ef3-a94f-2fb6017dfbcd', invitation });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO inbound_calendar_invitations');
    expect(sql).toContain('ON CONFLICT (message_id) DO UPDATE');
    for (const column of ['method', 'state', 'uid', 'recurrence_id', 'sequence', 'summary', 'organizer', 'starts_at', 'ends_at', 'all_day', 'timezone', 'raw_ical']) {
      expect(sql).toContain(`${column} = EXCLUDED.${column}`);
    }
    expect(params).toEqual([
      '4b7b090d-ec0f-4ef3-a94f-2fb6017dfbcd', 'REQUEST', 'pending', 'meeting-123', '', 2,
      'Planning', 'mailto:taylor@example.test', invitation.startsAt, invitation.endsAt, false,
      'Europe/Berlin', invitation.raw,
    ]);
  });

  it('replaces a prior request with a minimal cancellation projection', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const cancellation = {
      method: 'CANCEL', state: 'cancelled', uid: 'meeting-123', recurrenceId: '', sequence: 3,
      summary: null, organizer: null, startsAt: null, endsAt: null, allDay: null, timeZone: null, raw: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR',
    };

    await persistInboundCalendarInvitation({ query, messageId: '4b7b090d-ec0f-4ef3-a94f-2fb6017dfbcd', invitation: cancellation });

    expect(query.mock.calls[0][1].slice(1, 13)).toEqual([
      'CANCEL', 'cancelled', 'meeting-123', '', 3, null, null, null, null, null, null, cancellation.raw,
    ]);
    expect(query.mock.calls[0][0]).toContain('state = EXCLUDED.state');
  });
});
