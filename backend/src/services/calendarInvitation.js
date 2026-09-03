function escapeICalendarText(value) {
  return String(value || '')
    .replaceAll('\\', '\\\\')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\n', '\\n')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,');
}

function formatICalendarDate(value) {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll('-', '').replaceAll(':', '');
}

function formatInvitationDate(value, allDay) {
  return allDay ? value.toISOString().slice(0, 10).replaceAll('-', '') : formatICalendarDate(value);
}

function foldICalendarLine(line) {
  const chunks = [];
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

function invitationIcal({ uid, summary, description, location, organizerEmail, attendees, startsAt, endsAt, allDay, method, sequence }) {
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
  if (description) lines.push(`DESCRIPTION:${escapeICalendarText(description)}`);
  if (location) lines.push(`LOCATION:${escapeICalendarText(location)}`);
  for (const attendee of attendees) lines.push(`ATTENDEE;ROLE=REQ-PARTICIPANT:mailto:${attendee}`);
  lines.push('END:VEVENT', 'END:VCALENDAR', '');
  return lines.map(foldICalendarLine).join('\r\n');
}

export async function sendCalendarInvitation({ account, attendees, summary, description, location, uid, startsAt, endsAt, allDay = false, method = 'REQUEST', sequence = 0 }) {
  const { createAccountSmtpTransport } = await import('./smtpTransport.js');
  const smtp = await createAccountSmtpTransport(account);
  if (smtp.error) throw Object.assign(new Error(smtp.error), { status: smtp.status });
  const sendingAccount = smtp.account;
  const fromEmail = sendingAccount.email_address;
  const fromName = sendingAccount.sender_name || sendingAccount.name || fromEmail;
  const content = invitationIcal({ uid, summary, description, location, organizerEmail: fromEmail, attendees, startsAt, endsAt, allDay, method, sequence });
  await smtp.transport.sendMail({
    from: `${fromName} <${fromEmail}>`,
    to: attendees.join(', '),
    subject: `Invitation: ${summary || 'Meeting'}`,
    text: `${fromName} invited you to ${summary || 'a meeting'}.`,
    attachments: [{ filename: 'invitation.ics', content, contentType: `text/calendar; charset=utf-8; method=${method}` }],
  });
}
