import { descriptionContentLines } from '../utils/richText.js';

function escapeICalendarText(value: unknown): string {
  return String(value || '')
    .replaceAll('\\', '\\\\')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\n', '\\n')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,');
}

function formatICalendarDate(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll('-', '').replaceAll(':', '');
}

function formatInvitationDate(value: string | number | Date, allDay: boolean): string {
  const date = value instanceof Date ? value : new Date(value);
  return allDay ? date.toISOString().slice(0, 10).replaceAll('-', '') : formatICalendarDate(date);
}

function foldICalendarLine(line: string) {
  const chunks: string[] = [];
  let chunk = '';
  let limit = 75;
  for (const character of line) {
    if (Buffer.byteLength(chunk + character, 'utf8') > limit && chunk) {
      chunks.push(chunk);
      chunk = character;
      limit = 74;
    } else chunk += character;
  }
  chunks.push(chunk);
  return chunks.join('\r\n ');
}

/** One invitation to render and send. */
interface InvitationInput {
  uid: string;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  organizerEmail?: string | null;
  attendees: string[];
  startsAt: Date | string | number;
  endsAt: Date | string | number;
  allDay?: boolean;
  method?: string;
  sequence?: number;
}

/** The account slice the invitation is sent from. */
interface InvitationAccount { id?: string; email_address?: string | null; name?: string | null; [key: string]: unknown }

/** SMTP acceptance is per recipient even when Nodemailer resolves sendMail successfully. */
export type CalendarInvitationDelivery = {
  accepted: string[];
  rejected: string[];
};

function smtpRecipients(info: unknown, field: 'accepted' | 'rejected') {
  if (!info || typeof info !== 'object' || !(field in info)) return [];
  const value = (info as Record<string, unknown>)[field];
  return Array.isArray(value)
    ? value.filter((address): address is string => typeof address === 'string' && Boolean(address.trim()))
    : [];
}

function invitationIcal({ uid, summary, description, location, organizerEmail, attendees, startsAt, endsAt, allDay = false, method, sequence }: InvitationInput) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Inboxora//Calendar//EN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SEQUENCE:${sequence}`,
    `DTSTAMP:${formatICalendarDate(new Date())}`,
    `DTSTART${allDay ? ';VALUE=DATE' : ''}:${formatInvitationDate(startsAt, allDay)}`,
    `DTEND${allDay ? ';VALUE=DATE' : ''}:${formatInvitationDate(endsAt, allDay)}`,
    `ORGANIZER:mailto:${organizerEmail}`,
  ];
  if (method === 'CANCEL') lines.push('STATUS:CANCELLED');
  if (summary) lines.push(`SUMMARY:${escapeICalendarText(summary)}`);
  lines.push(...descriptionContentLines(description, escapeICalendarText));
  if (location) lines.push(`LOCATION:${escapeICalendarText(location)}`);
  for (const attendee of attendees) lines.push(`ATTENDEE;ROLE=REQ-PARTICIPANT:mailto:${attendee}`);
  lines.push('END:VEVENT', 'END:VCALENDAR', '');
  return lines.map(foldICalendarLine).join('\r\n');
}

export async function sendCalendarInvitation({ account, attendees, summary, description = null, location = null, uid, startsAt, endsAt, allDay = false, method = 'REQUEST', sequence = 0 }: InvitationInput & { account: InvitationAccount }) {
  const { createAccountSmtpTransport } = await import('./smtpTransport.js');
  const smtp = await createAccountSmtpTransport(account);
  if (smtp.error) throw Object.assign(new Error(smtp.error), { status: smtp.status });
  // createAccountSmtpTransport returns either { account, transport } or { status, error }; the guard above
  // catches the error branch, so this is unreachable - it exists so the compiler can see the same fact.
  if (!smtp.account || !smtp.transport) throw Object.assign(new Error(smtp.error || 'SMTP transport unavailable'), { status: smtp.status });
  const sendingAccount = smtp.account;
  const fromEmail = sendingAccount.email_address;
  const fromName = sendingAccount.sender_name || sendingAccount.name || fromEmail;
  const content = invitationIcal({ uid, summary, description, location, organizerEmail: fromEmail, attendees, startsAt, endsAt, allDay, method, sequence });
  const result = await smtp.transport.sendMail({
    from: `${fromName} <${fromEmail}>`,
    to: attendees.join(', '),
    subject: `Invitation: ${summary || 'Meeting'}`,
    text: `${fromName} invited you to ${summary || 'a meeting'}.`,
    attachments: [{ filename: 'invitation.ics', content, contentType: `text/calendar; charset=utf-8; method=${method}` }],
  });
  return {
    accepted: smtpRecipients(result, 'accepted'),
    rejected: smtpRecipients(result, 'rejected'),
  } satisfies CalendarInvitationDelivery;
}
