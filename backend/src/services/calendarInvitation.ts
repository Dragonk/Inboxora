import { randomUUID } from 'node:crypto';
import type { ComposedMail } from './composedMail.js';
import { withInvitationAlias } from './calendarInvitationSender.js';
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
  aliasId?: string | null;
  senderEmail?: string | null;
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
  /** Server-rendered RRULE of the series this invitation belongs to, when any. */
  rrule?: string | null;
  /**
   * The occurrence this message is about, for a scoped change to a series. The invitee's client matches it
   * against the occurrence it already holds, so a `REQUEST` or `CANCEL` without it would be read as a change
   * to the whole series rather than to the one occurrence the organiser edited.
   */
  recurrenceId?: string | null;
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

function invitationIcal({ uid, summary, description, location, organizerEmail, attendees, startsAt, endsAt, allDay = false, method, sequence, rrule = null, recurrenceId = null }: InvitationInput) {
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
  // A scoped message names the occurrence it is about, in the instant form the local resource stores.
  if (recurrenceId) lines.push(`RECURRENCE-ID:${formatInvitationDate(recurrenceId, allDay)}`);
  if (rrule) lines.push(`RRULE:${String(rrule).replace(/[\r\n]/g, '')}`);
  if (summary) lines.push(`SUMMARY:${escapeICalendarText(summary)}`);
  lines.push(...descriptionContentLines(description, escapeICalendarText));
  if (location) lines.push(`LOCATION:${escapeICalendarText(location)}`);
  for (const attendee of attendees) lines.push(`ATTENDEE;ROLE=REQ-PARTICIPANT:mailto:${attendee}`);
  lines.push('END:VEVENT', 'END:VCALENDAR', '');
  return lines.map(foldICalendarLine).join('\r\n');
}

export type PreparedCalendarInvitation = {
  // This is the only operation that invokes transport.sendMail. Callers can record
  // a durable dispatch marker immediately before it, after preparation completed.
  dispatch: () => Promise<CalendarInvitationDelivery>;
};

export async function prepareCalendarInvitation({ account, aliasId, senderEmail, attendees, summary, description = null, location = null, uid, startsAt, endsAt, allDay = false, method = 'REQUEST', sequence = 0, rrule = null, recurrenceId = null }: InvitationInput & { account: InvitationAccount }): Promise<PreparedCalendarInvitation> {
  const selectedAliasId = aliasId ?? (typeof account.invitation_alias_id === 'string' ? account.invitation_alias_id : null);
  const identity = selectedAliasId ? await withInvitationAlias(account,selectedAliasId) : account;
  const selectedEmail = typeof identity.invitation_from_email === 'string' ? identity.invitation_from_email : identity.email_address;
  if (senderEmail && senderEmail.toLowerCase() !== selectedEmail?.toLowerCase()) {
    throw Object.assign(new Error('The invitation sender identity changed; delivery was stopped'),{status:409});
  }
  if (account.mail_transport === 'gmail_api' || account.mail_transport === 'microsoft_graph') {
    if (!account.id || typeof account.user_id !== 'string') throw new Error('Invitation sender account is unavailable');
    const { resolveMailTransportForSync } = await import('./mailTransportTarget.js');
    const target=await resolveMailTransportForSync(account.user_id,account.id);
    if (target.kind==='refused') throw Object.assign(new Error(target.error),{status:target.status});
    const { createAccountMailTransport }=await import('./sendTransport.js');
    const binding=await createAccountMailTransport({...account,user_id:account.user_id,
      mail_transport:account.mail_transport,provider_connection_id:typeof account.provider_connection_id==='string' ? account.provider_connection_id : null});
    if (!('transport' in binding)) throw Object.assign(new Error(binding.error),{status:binding.status});
    if (!selectedEmail) throw new Error('Invitation sender address is unavailable');
    const fromName=typeof identity.invitation_from_name==='string' ? identity.invitation_from_name : typeof account.sender_name==='string' ? account.sender_name : account.name || selectedEmail;
    const content=invitationIcal({uid,summary,description,location,organizerEmail:selectedEmail,attendees,startsAt,endsAt,allDay,method,sequence,rrule,recurrenceId});
    const composed:ComposedMail={messageId:`<${randomUUID()}@inboxora>`,from:{email:selectedEmail,name:fromName},to:attendees.map(email=>({email})),cc:[],bcc:[],
      subject:`Invitation: ${summary || 'Meeting'}`,plainBody:`${fromName} invited you to ${summary || 'a meeting'}.`,
      attachments:[{filename:'invitation.ics',content:Buffer.from(content),contentType:`text/calendar; charset=utf-8; method=${method}`} ]};
    const refusal=await binding.transport.preflight?.(composed);
    if(refusal)throw Object.assign(new Error(refusal.error),{status:refusal.statusCode});
    return {dispatch:async()=>{
      const result=await binding.transport.send({composed});
      if(result.status==='accepted')return {accepted:[...attendees],rejected:[]};
      if(result.status==='refused')return {accepted:[],rejected:[...attendees]};
      // A provider timeout after dispatch is uncertain; the durable outbox must
      // never reinterpret it as a definitely unsent message or fall back to SMTP.
      throw new Error('Provider invitation delivery outcome is uncertain');
    }};
  }
  // Transport creation can refresh credentials, validate the TLS policy and resolve
  // DNS. None of those operations hands a message to SMTP, so an outbox can safely
  // retry an error raised before this function returns.
  const { createAccountSmtpTransport } = await import('./smtpTransport.js');
  const smtp = await createAccountSmtpTransport(account);
  if (smtp.error) throw Object.assign(new Error(smtp.error), { status: smtp.status });
  // createAccountSmtpTransport returns either { account, transport } or { status, error }; the guard above
  // catches the error branch, so this is unreachable - it exists so the compiler can see the same fact.
  if (!smtp.account || !smtp.transport) throw Object.assign(new Error(smtp.error || 'SMTP transport unavailable'), { status: smtp.status });
  const sendingAccount = smtp.account;
  const fromEmail = selectedAliasId ? selectedEmail : sendingAccount.email_address;
  const fromName = selectedAliasId && typeof identity.invitation_from_name === 'string' ? identity.invitation_from_name : sendingAccount.sender_name || sendingAccount.name || fromEmail;
  const content = invitationIcal({ uid, summary, description, location, organizerEmail: fromEmail, attendees, startsAt, endsAt, allDay, method, sequence, rrule, recurrenceId });
  return {
    dispatch: async () => {
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
    },
  };
}

export async function sendCalendarInvitation(input: InvitationInput & { account: InvitationAccount }) {
  return (await prepareCalendarInvitation(input)).dispatch();
}
