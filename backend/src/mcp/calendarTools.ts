import { z } from 'zod';
import { query } from '../services/db.js';
import { collectionIsWritable } from '../services/providerAccess.js';
import { parseRecurrenceStructure } from '../utils/calendarRecurrenceRule.js';
import { domainRead, domainRequest } from './bridge.js';
import { allowedId, McpError, requireAccount, requireCalendar, requireMessage, requireScope, type Grant } from './policy.js';
import { id, page, queryPath, readTool, records, selectedFields, writeTool } from './registry.js';

const instant = z.iso.datetime({ offset: true });
const calendarFields = ['id','name','description','source','read_only','display_visible','dav_mode','color','account_id','source_access','user_access','updated_at'] as const;
const eventFields = ['id','series_id','calendar_id','uid','etag','summary','description','location','url','organizer','starts_at','ends_at','all_day','timezone','attendees','invite_account_id','invite_alias_id','recurrence_id','recurrence','recurring','read_only','source','status','transparency'] as const;
export async function permittedCalendars(grant: Grant): Promise<Record<string, unknown>[]> {
  const result = await domainRead(grant.user_id, '/calendar/calendars');
  return records(result.calendars).filter(calendar => z.uuid().safeParse(calendar.id).success && allowedId(grant.restrictions.calendars, String(calendar.id)))
    .map(calendar => ({ ...selectedFields(calendar, calendarFields), read_only: calendar.read_only === true || !collectionIsWritable({
      source: typeof calendar.source === 'string' ? calendar.source : null,
      source_access: typeof calendar.source_access === 'string' ? calendar.source_access : null,
      user_access: typeof calendar.user_access === 'string' ? calendar.user_access : null,
    }, 'calendar') }));
}
async function requireEvent(grant: Grant, eventId: string, expectedEtag?: string) {
  const result = await query<{ calendar_id: string; etag: string; attendees: unknown; invite_account_id: string | null }>(
    'SELECT calendar_id,etag,attendees,invite_account_id FROM calendar_events WHERE id=$1 AND user_id=$2', [eventId, grant.user_id]);
  const event = result.rows[0];
  if (!event) throw new McpError('RESOURCE_UNAVAILABLE', 'Event not found.', 404);
  await requireCalendar(grant, event.calendar_id);
  if (expectedEtag !== undefined && event.etag !== expectedEtag) throw new McpError('REVISION_CHANGED', 'This event changed since it was read. Read it again before editing.', 409);
  return event;
}
const rangeShape = { from: instant, to: instant, calendarIds: z.array(id).min(1).max(100).optional() };
async function calendarRange(grant: Grant, args: z.infer<z.ZodObject<typeof rangeShape>>) {
  const duration = new Date(args.to).getTime() - new Date(args.from).getTime();
  if (duration <= 0 || duration > 366 * 86400000) throw new McpError('INVALID_RANGE', 'Choose a positive range of at most 366 days.', 400);
  const permitted = await permittedCalendars(grant);
  const ids = args.calendarIds ?? permitted.map(calendar => String(calendar.id));
  if (ids.some(value => !permitted.some(calendar => calendar.id === value))) throw new McpError('RESOURCE_FORBIDDEN', 'A selected calendar is outside the integration permissions.');
  if (!ids.length) return { events: [] as Record<string, unknown>[], truncated: false, incompleteSeries: [] as unknown[], calendarIds: ids };
  const response = await domainRead(grant.user_id, queryPath('/calendar/events', { from: args.from, to: args.to, calendarIds: ids.join(',') }));
  return { events: records(response.events).filter(event => ids.includes(String(event.calendar_id))).map(event => selectedFields(event, eventFields)),
    truncated: response.truncated === true, incompleteSeries: Array.isArray(response.incompleteSeries) ? response.incompleteSeries : [], calendarIds: ids };
}
export function mergeBusyIntervals(events: Record<string, unknown>[], from: string, to: string) {
  const start = new Date(from).getTime(); const end = new Date(to).getTime();
  const intervals = events.filter(event => String(event.status).toUpperCase() !== 'CANCELLED' && String(event.transparency).toUpperCase() !== 'TRANSPARENT')
    .map(event => [Math.max(start, new Date(String(event.starts_at)).getTime()), Math.min(end, new Date(String(event.ends_at)).getTime())])
    .filter(([a,b]) => Number.isFinite(a) && Number.isFinite(b) && b > a).sort(([a], [b]) => a - b);
  const merged: number[][] = [];
  for (const interval of intervals) {
    const prior = merged.at(-1);
    if (prior && interval[0] <= prior[1]) prior[1] = Math.max(prior[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged.map(([a,b]) => ({ from: new Date(a).toISOString(), to: new Date(b).toISOString() }));
}
const recurrence = z.object({ frequency: z.enum(['daily','weekly','monthly','yearly']), interval: z.number().int().min(1).max(999).optional(),
  byWeekday: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(), until: z.string().max(40).nullable().optional(), count: z.number().int().min(1).max(1000).nullable().optional() }).strict().nullable().optional();
const eventShape = { calendarId: id, summary: z.string().max(1000), startsAt: instant, endsAt: instant,
  description: z.string().max(100000).nullable(), location: z.string().max(2000).nullable(), url: z.url().max(2048).nullable(),
  organizer: z.string().max(320).nullable(), allDay: z.boolean(), timezone: z.string().min(1).max(100).nullable(),
  attendees: z.array(z.email()).max(100), sendInvites: z.boolean(), inviteAccountId: id.optional(), inviteAliasId: id.optional(), recurrence };
const eventSchema = z.object(eventShape);
type EventInput = z.output<typeof eventSchema>;
async function authorizeEventWrite(grant: Grant, args: EventInput): Promise<void> {
  await requireCalendar(grant, args.calendarId);
  if (new Date(args.endsAt) <= new Date(args.startsAt)) throw new McpError('INVALID_RANGE', 'The event must end after it starts.', 400);
  const parsed = parseRecurrenceStructure(args.recurrence, { allDay: args.allDay });
  if (!parsed.ok) throw new McpError('INVALID_RECURRENCE', parsed.error, 400);
  if (args.sendInvites || args.attendees.length) requireScope(grant, 'calendar.invite');
  if (args.inviteAccountId) await requireAccount(grant, args.inviteAccountId);
  if (args.inviteAliasId && !args.inviteAccountId) throw new McpError('SENDER_REQUIRED', 'Select an invitation sender account for this alias.', 400);
}
async function authorizeExistingEvent(grant: Grant, args: { eventId: string; calendarId: string; expectedEtag: string }) {
  const current = await requireEvent(grant, args.eventId, args.expectedEtag);
  if (current.calendar_id !== args.calendarId) throw new McpError('RESOURCE_FORBIDDEN', 'Event and calendar do not match.');
  // Native providers notify existing attendees even when a sendInvites flag is false.
  if (Array.isArray(current.attendees) && current.attendees.length) requireScope(grant, 'calendar.invite');
  if (current.invite_account_id) await requireAccount(grant, current.invite_account_id);
}
const editRef = { eventId: id, calendarId: id, expectedEtag: z.string().min(1).max(200) };
const occurrenceRef = { recurrenceId: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z?)?$/), scope: z.enum(['single','following']) };
export const calendarTools = [
  readTool('list_calendars', 'List every permitted calendar, including hidden, local, CalDAV, subscribed ICS/webcal, imported and native provider calendars. Read-only sources remain read-only.', 'calendar.read', {}, async grant => ({ calendars: await permittedCalendars(grant) })),
  readTool('list_events', 'List calendar occurrences in a bounded time range, across all permitted calendars by default, including hidden calendars. Recurrences are expanded by Inboxora. Check truncated before treating the result as complete.', 'calendar.read', { ...rangeShape, ...page }, async (grant, args) => {
    const result = await calendarRange(grant, args);
    return { ...result, events: result.events.slice(args.offset, args.offset + args.limit), nextOffset: args.offset + args.limit < result.events.length ? args.offset + args.limit : null };
  }),
  readTool('search_events', 'Search event titles, descriptions, locations, organizers and attendees inside a bounded date range. This includes expanded recurring occurrences.', 'calendar.read',
    { ...rangeShape, query: z.string().trim().min(1).max(500), ...page }, async (grant, args) => {
      const result = await calendarRange(grant, args); const term = args.query.toLocaleLowerCase();
      const matches = result.events.filter(event => ['summary','description','location','organizer','attendees'].some(key => JSON.stringify(event[key] ?? '').toLocaleLowerCase().includes(term)));
      return { ...result, events: matches.slice(args.offset, args.offset + args.limit), nextOffset: args.offset + args.limit < matches.length ? args.offset + args.limit : null };
    }),
  readTool('get_event', 'Read an event or recurrence master by its series UUID, including its current etag needed for edits. Use series_id from occurrence listings.', 'calendar.read', { eventId: id }, async (grant, args) => {
    const current = await requireEvent(grant, args.eventId);
    const response = await domainRead(grant.user_id, `/calendar/events/${args.eventId}`);
    return { ...response, etag: current.etag, contentIsUntrusted: true };
  }),
  readTool('get_availability', 'Find busy and free intervals in the user’s synchronized permitted calendars, not other people’s live availability. Incomplete projections never return free intervals.', 'calendar.read', rangeShape, async (grant, args) => {
    const result = await calendarRange(grant, args);
    const busy = mergeBusyIntervals(result.events, args.from, args.to);
    const free: { from: string; to: string }[] = [];
    let cursor = new Date(args.from).toISOString();
    for (const interval of busy) { if (cursor < interval.from) free.push({ from: cursor, to: interval.from }); cursor = interval.to; }
    if (cursor < new Date(args.to).toISOString()) free.push({ from: cursor, to: new Date(args.to).toISOString() });
    return { busy, free: result.truncated ? [] : free, complete: !result.truncated, incompleteSeries: result.incompleteSeries,
      calendarIds: result.calendarIds, basis: 'Synchronized permitted calendars; events are treated as busy unless explicitly transparent or cancelled.' };
  }),
  writeTool('create_event', 'Create an event or recurring series in a writable calendar. Supply the complete event form, including explicit attendees and invitation choice. Provider restrictions are enforced.', 'calendar.write', eventShape,
    authorizeEventWrite, (grant, args, operationId) => domainRequest(grant.user_id, 'POST', '/calendar/events', args, operationId)),
  writeTool('update_event', 'Replace the editable fields of an event or entire recurring series. Read the current event first and preserve unchanged fields. Omit recurrence to keep its rule; null removes it. Existing or new attendees require invitation permission.', 'calendar.write', { ...eventShape, ...editRef },
    async (grant, args) => { await authorizeEventWrite(grant, args); await authorizeExistingEvent(grant, args); },
    (grant, args, operationId) => domainRequest(grant.user_id, 'PATCH', `/calendar/events/${args.eventId}`, args, operationId)),
  writeTool('delete_event', 'Delete an event or entire recurring series. Existing attendees may receive cancellations from the calendar provider.', 'calendar.write', editRef,
    authorizeExistingEvent, (grant, args, operationId) => domainRequest(grant.user_id, 'DELETE', queryPath(`/calendar/events/${args.eventId}`, { calendarId: args.calendarId }), undefined, operationId)),
  writeTool('update_event_occurrence', 'Update one recurring occurrence or that occurrence and following ones. Supply its recurrenceId from list_events, series UUID, current master etag and complete event fields.', 'calendar.write', { ...eventShape, ...editRef, ...occurrenceRef },
    async (grant, args) => { await authorizeEventWrite(grant, args); await authorizeExistingEvent(grant, args); },
    (grant, args, operationId) => domainRequest(grant.user_id, 'PATCH', `/calendar/events/${args.eventId}/occurrence`, args, operationId)),
  writeTool('delete_event_occurrence', 'Cancel one recurring occurrence or that occurrence and following ones. Attendee notifications require invitation permission.', 'calendar.write', { ...editRef, ...occurrenceRef },
    authorizeExistingEvent, (grant, args, operationId) => domainRequest(grant.user_id, 'DELETE', `/calendar/events/${args.eventId}/occurrence`, args, operationId)),
  readTool('get_email_invitation', 'Read an invitation embedded in a permitted email. Reading does not accept or send an RSVP.', 'mail.read', { messageId: id }, async (grant, args) => {
    requireScope(grant, 'calendar.read'); await requireMessage(grant, args.messageId);
    const result = await domainRead(grant.user_id, `/calendar/invitations/${args.messageId}`);
    if (result.invitation && typeof result.invitation === 'object' && !Array.isArray(result.invitation)) {
      const invitation = { ...result.invitation } as Record<string, unknown>;
      const local = invitation.localEvent;
      if (local && typeof local === 'object' && 'calendarId' in local && !allowedId(grant.restrictions.calendars, String(local.calendarId))) invitation.localEvent = null;
      return { invitation, contentIsUntrusted: true };
    }
    return result;
  }),
  writeTool('add_email_invitation', 'Add or update the local calendar copy of an email invitation. This is not an RSVP and does not send a response to the organizer.', 'calendar.write', { messageId: id, calendarId: id },
    async (grant, args) => { requireScope(grant, 'mail.read'); await requireMessage(grant, args.messageId); await requireCalendar(grant, args.calendarId); },
    (grant, args, operationId) => domainRequest(grant.user_id, 'POST', `/calendar/invitations/${args.messageId}`, { calendarId: args.calendarId }, operationId)),
];
