import { describe, expect, it, vi } from 'vitest';

const { createAccountSmtpTransport } = vi.hoisted(() => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('./smtpTransport.js', () => ({ createAccountSmtpTransport }));

import { sendCalendarInvitation } from './calendarInvitation.js';
import { parseInboundCalendarInvitation } from './inboundCalendarInvitation.js';

describe('sendCalendarInvitation', () => {
  it('sends a METHOD:REQUEST iCalendar attachment from the selected account', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    createAccountSmtpTransport.mockResolvedValue({ account: { email_address: 'organizer@example.test', sender_name: 'Organizer' }, transport: { sendMail } });

    await sendCalendarInvitation({
      account: { id: 'account-1', email_address: 'organizer@example.test' },
      attendees: ['guest@example.test'], summary: 'Planning', uid: 'event-1',
      startsAt: new Date('2026-09-01T09:00:00.000Z'), endsAt: new Date('2026-09-01T10:00:00.000Z'),
    });

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: 'Organizer <organizer@example.test>', to: 'guest@example.test', subject: 'Invitation: Planning',
      attachments: [expect.objectContaining({ contentType: 'text/calendar; charset=utf-8; method=REQUEST' })],
    }));
    expect(sendMail.mock.calls[0][0].attachments[0].content).toContain('METHOD:REQUEST');
    expect(sendMail.mock.calls[0][0].attachments[0].content).toContain('ATTENDEE;ROLE=REQ-PARTICIPANT:mailto:guest@example.test');
  });

  it('escapes lone carriage returns in invitation text to prevent iCalendar property injection', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    createAccountSmtpTransport.mockResolvedValue({ account: { email_address: 'organizer@example.test' }, transport: { sendMail } });

    await sendCalendarInvitation({
      account: { id: 'account-1' }, attendees: ['guest@example.test'], summary: 'Planning',
      description: 'Details\rX-INJECTED: true', uid: 'event-4',
      startsAt: new Date('2026-09-01T09:00:00.000Z'), endsAt: new Date('2026-09-01T10:00:00.000Z'),
    });

    const content = sendMail.mock.calls[0][0].attachments[0].content;
    expect(content).toContain('DESCRIPTION:Details\\nX-INJECTED: true');
    expect(content).not.toContain('\rX-INJECTED: true');
  });

  it('uses DATE values for all-day invitations', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    createAccountSmtpTransport.mockResolvedValue({ account: { email_address: 'organizer@example.test', sender_name: 'Organizer' }, transport: { sendMail } });

    await sendCalendarInvitation({ account: { id: 'account-1' }, attendees: ['guest@example.test'], summary: 'Holiday', uid: 'event-2', allDay: true, startsAt: new Date('2026-09-01T00:00:00.000Z'), endsAt: new Date('2026-09-02T00:00:00.000Z') });

    expect(sendMail.mock.calls[0][0].attachments[0].content).toContain('DTSTART;VALUE=DATE:20260901');
    expect(sendMail.mock.calls[0][0].attachments[0].content).toContain('DTEND;VALUE=DATE:20260902');
  });

  it('folds long invitation properties without splitting UTF-8 characters', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    createAccountSmtpTransport.mockResolvedValue({ account: { email_address: 'organizer@example.test' }, transport: { sendMail } });

    await sendCalendarInvitation({
      account: { id: 'account-1' }, attendees: ['guest@example.test'], summary: 'Release ' + 'ż'.repeat(40),
      uid: 'event-5', startsAt: new Date('2026-09-01T00:00:00.000Z'), endsAt: new Date('2026-09-02T00:00:00.000Z'),
    });

    const content = sendMail.mock.calls[0][0].attachments[0].content;
    expect(content).toContain('SUMMARY:Release ');
    expect(content).toContain('\r\n ');
    for (const line of content.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
  });

  it('marks invitation revisions and cancellations with their iCalendar method and sequence', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    createAccountSmtpTransport.mockResolvedValue({ account: { email_address: 'organizer@example.test', sender_name: 'Organizer' }, transport: { sendMail } });

    await sendCalendarInvitation({
      account: { id: 'account-1' }, attendees: ['guest@example.test'], summary: 'Cancelled planning', uid: 'event-3',
      startsAt: new Date('2026-09-01T09:00:00.000Z'), endsAt: new Date('2026-09-01T10:00:00.000Z'), method: 'CANCEL', sequence: 2,
    });

    const content = sendMail.mock.calls[0][0].attachments[0].content;
    expect(content).toContain('METHOD:CANCEL');
    expect(content).toContain('SEQUENCE:2');
    expect(content).toContain('STATUS:CANCELLED');
    expect(content.match(/^STATUS:CANCELLED$/gm)).toHaveLength(1);
  });

  it('round-trips generated cancellations through the inbound parser', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    createAccountSmtpTransport.mockResolvedValue({ account: { email_address: 'organizer@example.test' }, transport: { sendMail } });

    await sendCalendarInvitation({
      account: { id: 'account-1' }, attendees: ['guest@example.test'], summary: 'Cancelled planning', uid: 'event-round-trip',
      startsAt: new Date('2026-09-01T09:00:00.000Z'), endsAt: new Date('2026-09-01T10:00:00.000Z'), method: 'CANCEL', sequence: 2,
    });

    expect(parseInboundCalendarInvitation(sendMail.mock.calls[0][0].attachments[0].content)).toMatchObject({
      method: 'CANCEL', state: 'cancelled', uid: 'event-round-trip', sequence: 2,
      organizer: 'mailto:organizer@example.test', summary: 'Cancelled planning',
    });
  });
});