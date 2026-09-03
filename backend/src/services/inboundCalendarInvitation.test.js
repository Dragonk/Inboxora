import { describe, expect, it } from 'vitest';
import { parseInboundCalendarInvitation } from './inboundCalendarInvitation.js';

describe('inbound calendar invitations', () => {
  it('projects a bounded REQUEST with folded text, recurrence identity, and raw ICS preservation', () => {
    const raw = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:meeting-123\r\nRECURRENCE-ID;TZID=Europe/Berlin:20260901T090000\r\nSEQUENCE:2\r\nDTSTAMP:20260901T070000Z\r\nDTSTART;TZID=Europe/Berlin:20260908T090000\r\nDTEND;TZID=Europe/Berlin:20260908T100000\r\nSUMMARY:Planning \r\n for Inboxora\r\nORGANIZER;CN=Taylor:mailto:taylor@example.test\r\nATTENDEE;CN=Sam;PARTSTAT=NEEDS-ACTION:mailto:sam@example.test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

    expect(parseInboundCalendarInvitation(raw)).toEqual({
      method: 'REQUEST',
      state: 'pending',
      uid: 'meeting-123',
      recurrenceId: '20260901T070000Z',
      sequence: 2,
      summary: 'Planning for Inboxora',
      organizer: 'mailto:taylor@example.test',
      startsAt: new Date('2026-09-08T07:00:00.000Z'),
      endsAt: new Date('2026-09-08T08:00:00.000Z'),
      allDay: false,
      timeZone: 'Europe/Berlin',
      raw,
    });
  });

  it('requires a complete VCALENDAR envelope and a calendar-level METHOD', () => {
    const validEvent = 'BEGIN:VEVENT\r\nUID:meeting-123\r\nSEQUENCE:0\r\nDTSTAMP:20260901T070000Z\r\nDTSTART:20260908T090000Z\r\nDTEND:20260908T100000Z\r\nORGANIZER:mailto:taylor@example.test\r\nATTENDEE:mailto:sam@example.test\r\nEND:VEVENT';

    expect(parseInboundCalendarInvitation(`METHOD:REQUEST\r\n${validEvent}`)).toBeNull();
    expect(parseInboundCalendarInvitation(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${validEvent}\r\nEND:VCALENDAR`)).toBeNull();
    expect(parseInboundCalendarInvitation(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${validEvent.replace('UID:meeting-123', 'METHOD:REQUEST\r\nUID:meeting-123')}\r\nEND:VCALENDAR`)).toBeNull();
  });

  it('rejects mixed time representations and ambiguous or nonexistent local wall times', () => {
    const event = (start, end) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:meeting-123\r\nSEQUENCE:0\r\nDTSTAMP:20260901T070000Z\r\n${start}\r\n${end}\r\nORGANIZER:mailto:taylor@example.test\r\nATTENDEE:mailto:sam@example.test\r\nEND:VEVENT\r\nEND:VCALENDAR`;

    expect(parseInboundCalendarInvitation(event('DTSTART;TZID=Europe/Berlin:20261025T023000', 'DTEND:20261025T023000Z'))).toBeNull();
    expect(parseInboundCalendarInvitation(event('DTSTART;TZID=Europe/Berlin:20261025T023000', 'DTEND;TZID=Europe/Berlin:20261025T033000'))).toBeNull();
    expect(parseInboundCalendarInvitation(event('DTSTART;TZID=Europe/Berlin:20260329T023000', 'DTEND;TZID=Europe/Berlin:20260329T033000'))).toBeNull();
    expect(parseInboundCalendarInvitation(event('DTSTART:20260908T090000Z', 'DTEND:20260908T100000Z').replace('SEQUENCE:0', 'SEQUENCE:0\r\nRECURRENCE-ID;TZID=Europe/Berlin:20260901T090000'))).toBeNull();
  });

  it('accepts actionable REQUESTs and RFC 5546 CANCEL properties', () => {
    const requestWithoutStamp = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:meeting-123\r\nDTSTART:20260908T090000Z\r\nDTEND:20260908T100000Z\r\nORGANIZER:mailto:taylor@example.test\r\nATTENDEE:mailto:sam@example.test\r\nEND:VEVENT\r\nEND:VCALENDAR';
    const cancel = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:CANCEL\r\nBEGIN:VEVENT\r\nUID:meeting-123\r\nDTSTAMP:20260901T070000Z\r\nDTSTART:20260908T090000Z\r\nDTEND:20260908T100000Z\r\nSEQUENCE:3\r\nORGANIZER:mailto:taylor@example.test\r\nSTATUS:CANCELLED\r\nSUMMARY:Cancelled planning\r\nDESCRIPTION:No longer happening\r\nLOCATION:Room 42\r\nATTENDEE;ROLE=REQ-PARTICIPANT:mailto:sam@example.test\r\nEND:VEVENT\r\nEND:VCALENDAR';
    const reply = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REPLY\r\nBEGIN:VEVENT\r\nUID:meeting-123\r\nSEQUENCE:3\r\nDTSTAMP:20260901T070000Z\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:sam@example.test\r\nEND:VEVENT\r\nEND:VCALENDAR';

    expect(parseInboundCalendarInvitation(requestWithoutStamp)).toBeNull();
    expect(parseInboundCalendarInvitation(reply)).toBeNull();
    expect(parseInboundCalendarInvitation(cancel)).toMatchObject({
      method: 'CANCEL', state: 'cancelled', uid: 'meeting-123', sequence: 3,
      startsAt: new Date('2026-09-08T09:00:00.000Z'), endsAt: new Date('2026-09-08T10:00:00.000Z'),
      summary: 'Cancelled planning', organizer: 'mailto:taylor@example.test', allDay: false, timeZone: null,
    });
    expect(parseInboundCalendarInvitation(cancel.replace('DTSTAMP:20260901T070000Z', 'DTSTAMP:20260901T070000Z\r\nDTSTART:20260908T090000Z'))).toBeNull();
    expect(parseInboundCalendarInvitation(cancel.replace('ORGANIZER:mailto:taylor@example.test', 'ORGANIZER:mailto:one@example.test\r\nORGANIZER:mailto:two@example.test'))).toBeNull();
    expect(parseInboundCalendarInvitation(cancel.replace('SEQUENCE:3', 'SEQUENCE:   '))).toBeNull();
    expect(parseInboundCalendarInvitation(cancel.replace('STATUS:CANCELLED', 'STATUS:CONFIRMED'))).toBeNull();
  });

  it('rejects empty participants, non-UTC stamps, and malformed nested components', () => {
    const request = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:meeting-123\r\nSEQUENCE:0\r\nDTSTAMP:20260901T070000Z\r\nDTSTART:20260908T090000Z\r\nDTEND:20260908T100000Z\r\nORGANIZER:mailto:taylor@example.test\r\nATTENDEE:mailto:sam@example.test\r\nEND:VEVENT\r\nEND:VCALENDAR';

    expect(parseInboundCalendarInvitation(request.replace('ORGANIZER:mailto:taylor@example.test', 'ORGANIZER:   '))).toBeNull();
    expect(parseInboundCalendarInvitation(request.replace('ATTENDEE:mailto:sam@example.test', 'ATTENDEE:   '))).toBeNull();
    expect(parseInboundCalendarInvitation(request.replace('DTSTAMP:20260901T070000Z', 'DTSTAMP;TZID=Europe/Berlin:20260901T090000'))).toBeNull();
    expect(parseInboundCalendarInvitation(request.replace('END:VEVENT', 'BEGIN:VALARM\r\nEND:VCALENDAR\r\nEND:VEVENT'))).toBeNull();
    expect(parseInboundCalendarInvitation(request.replace('ATTENDEE:mailto:sam@example.test', 'ATTENDEE:mailto:sam@example.test\r\nBEGIN:VALARM\r\nSUMMARY:Nested alarm must not become event metadata\r\nEND:VALARM'))).toMatchObject({ summary: null, uid: 'meeting-123' });
  });
});
