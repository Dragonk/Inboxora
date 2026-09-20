import { GraphApiError, type GraphApiOptions } from './graphApiClient.js';
import {
  createGraphEvent,
  deleteGraphEvent,
  patchGraphEvent,
  type GraphEvent,
  type GraphEventPayload,
  type GraphRecurrencePattern,
  type GraphRecurrenceRange,
} from './graphCalendar.js';
import { classifyGraphMutationFailure } from './graphMailMutations.js';
import type { ProviderAdapterOutcome, ProviderMutationAdapter } from '../../providerMutationService.js';
import type { ParsedRecurrence } from '../../../utils/calendarRecurrenceRule.js';

/**
 * Microsoft Graph **calendar-event writes** (P09, calendar CRUD).
 *
 * The provider is written first and the local projection second, through the shared journal, so a refusal
 * or an unknown outcome never leaves a local row claiming a change Microsoft did not accept. The three
 * operations are declared non-idempotent as a whole for the same reason the contact adapter is: a create
 * addresses a calendar rather than a resource, so a replayed create would duplicate the event, and a
 * delete answers `404` for an event that is already gone, which cannot be told apart from "never existed".
 *
 * Times are sent as **UTC wall time with `timeZone: 'UTC'`**. The local model stores an instant and keeps
 * the user's zone as metadata, so sending the instant is exactly faithful; inventing a zone-specific wall
 * time from metadata would silently move the event whenever the two disagreed.
 */
export interface LocalEventWriteInput {
  summary: string | null;
  description: string | null;
  location: string | null;
  url: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  attendees: string[];
  /**
   * The series rule for this write. `undefined` means "this write says nothing about the rule" (an
   * occurrence edit, or an update that only moves a one-off), `null` means "make the event a one-off", and
   * an object sets the rule. The distinction matters: a PATCH that omitted the field would leave the
   * provider's old series in place while the local copy became a single event.
   */
  recurrence?: ParsedRecurrence | null;
}

export interface GraphCalendarEventWritePayload {
  operation: 'create' | 'update' | 'delete';
  /** The provider's calendar id. */
  calendarId: string;
  /** The provider's event id, for an update or delete. */
  eventId?: string | null;
  event?: LocalEventWriteInput;
  /** A caller-supplied id Graph rejects a repeated create with, so a retry cannot duplicate. */
  transactionId?: string | null;
}

/** The UTC wall clock Graph wants, with no offset suffix. */
function utcWallClock(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '');
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The Graph `pattern`/`range` for a validated local recurrence.
 *
 * The structure is the one the route already validated (`parseRecurrenceStructure`), so this is a
 * rendering rather than a parse: monthly and yearly patterns repeat on the start's own day, which is what
 * an `RRULE` without `BYMONTHDAY`/`BYMONTH` means.
 */
export function graphRecurrenceFromStructure(recurrence: ParsedRecurrence, startsAt: Date): { pattern: GraphRecurrencePattern; range: GraphRecurrenceRange } {
  const pattern: GraphRecurrencePattern = { type: 'daily', interval: recurrence.interval };
  const startDate = isoDate(startsAt);
  switch (recurrence.frequency) {
    case 'daily':
      pattern.type = 'daily';
      break;
    case 'weekly': {
      pattern.type = 'weekly';
      // A weekly rule with no BYDAY repeats on the start's own weekday, which is what an RRULE without
      // BYDAY means; Graph requires the list to be explicit.
      const days = recurrence.byWeekday.length ? recurrence.byWeekday : [startsAt.getUTCDay()];
      pattern.daysOfWeek = days.map(day => DAY_NAMES[day] ?? 'monday');
      pattern.firstDayOfWeek = 'sunday';
      break;
    }
    case 'monthly':
      pattern.type = 'absoluteMonthly';
      pattern.dayOfMonth = startsAt.getUTCDate();
      break;
    case 'yearly':
      pattern.type = 'absoluteYearly';
      pattern.month = startsAt.getUTCMonth() + 1;
      pattern.dayOfMonth = startsAt.getUTCDate();
      break;
  }
  if (recurrence.count) {
    return { pattern, range: { type: 'numbered', numberOfOccurrences: recurrence.count, startDate } };
  }
  if (recurrence.until) {
    const until = new Date(recurrence.until);
    if (!Number.isNaN(until.getTime())) return { pattern, range: { type: 'endDate', endDate: isoDate(until), startDate } };
  }
  return { pattern, range: { type: 'noEnd', startDate } };
}

/** The Graph event body for a local event. */
export function graphEventPayloadFor(event: LocalEventWriteInput, transactionId?: string | null): GraphEventPayload {
  const payload: GraphEventPayload = {
    subject: event.summary ?? '',
    start: { dateTime: utcWallClock(event.startsAt), timeZone: 'UTC' },
    end: { dateTime: utcWallClock(event.endsAt), timeZone: 'UTC' },
  };
  if (event.allDay) payload.isAllDay = true;
  if (event.description) payload.body = { contentType: 'Text', content: event.description };
  if (event.location) payload.location = { displayName: event.location };
  if (event.attendees.length) payload.attendees = event.attendees.map(address => ({ emailAddress: { address }, type: 'required' }));
  if (event.recurrence === null) {
    // Graph clears a property when it is sent as `null`; omitting it leaves the series untouched.
    payload.recurrence = null;
  } else if (event.recurrence) {
    payload.recurrence = graphRecurrenceFromStructure(event.recurrence, event.startsAt);
  }
  if (transactionId) payload.transactionId = transactionId;
  return payload;
}

export interface GraphEventWriteResult {
  event?: GraphEvent | null;
}

export function graphCalendarEventMutationAdapter(options: {
  api: GraphApiOptions;
  create?: typeof createGraphEvent;
  patch?: typeof patchGraphEvent;
  remove?: typeof deleteGraphEvent;
}): ProviderMutationAdapter<GraphCalendarEventWritePayload, GraphEventWriteResult> {
  const create = options.create ?? createGraphEvent;
  const patch = options.patch ?? patchGraphEvent;
  const remove = options.remove ?? deleteGraphEvent;
  return {
    resourceType: 'calendar_event',
    idempotent: false,
    async perform(write): Promise<ProviderAdapterOutcome<GraphEventWriteResult>> {
      try {
        if (write.operation === 'create') {
          if (!write.event) return { status: 'permanent', code: 'INVALID_REQUEST' };
          const created = await create(options.api, write.calendarId, graphEventPayloadFor(write.event, write.transactionId));
          // An event Graph answers without an id cannot be reconciled against a replay.
          if (!created?.id) return { status: 'outcome_unknown', code: 'EVENT_ID_MISSING' };
          return { status: 'committed', value: { event: created } };
        }
        if (!write.eventId) return { status: 'permanent', code: 'RESOURCE_NOT_FOUND' };
        if (write.operation === 'update') {
          if (!write.event) return { status: 'permanent', code: 'INVALID_REQUEST' };
          const updated = await patch(options.api, write.calendarId, write.eventId, graphEventPayloadFor(write.event));
          return { status: 'committed', value: { event: updated } };
        }
        await remove(options.api, write.calendarId, write.eventId);
        return { status: 'committed' };
      } catch (error) {
        // An event the provider no longer has is a permanent fact, and for a delete it is the end state.
        if (error instanceof GraphApiError && error.code === 'RESOURCE_NOT_FOUND') {
          return { status: 'permanent', code: 'RESOURCE_NOT_FOUND' };
        }
        return classifyGraphMutationFailure(error);
      }
    },
  };
}
