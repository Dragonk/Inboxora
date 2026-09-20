import { googleConfigFromEnv, microsoftConfigFromEnv } from './providerAuthService.js';
import { runProviderMutation } from './providerMutationService.js';
import type { ProviderAdapterOutcome, ProviderMutationAdapter } from './providerMutationService.js';
import { providerWriteFailure, type ProviderWriteFailure } from './providerWriteFailure.js';
import type { GoogleEventWriteInput } from './providerGoogleWrites.js';
import {
  deleteGoogleEvent,
  fetchGoogleEvent,
  fetchGoogleEventInstances,
  insertGoogleEvent,
  patchGoogleEvent,
} from './providers/google/googleCalendar.js';
import { googleEventPayloadFor } from './providerGoogleWrites.js';
import { graphEventPayloadFor, graphRecurrenceFromStructure, type LocalEventWriteInput } from './providers/microsoft/graphCalendarWrites.js';
import {
  createGraphEvent,
  deleteGraphEvent,
  fetchGraphEvent,
  fetchGraphEventInstances,
  patchGraphEvent,
  type GraphEventPayload,
} from './providers/microsoft/graphCalendar.js';
import { classifyGmailMailMutationFailure } from './providers/google/gmailMailMutations.js';
import type { ParsedRecurrence } from '../utils/calendarRecurrenceRule.js';

/**
 * One occurrence of a provider series, and the two scopes a user can act on besides the whole series.
 *
 * The local model stores a series as one row whose `raw_ical` holds the master plus its overrides, which is
 * enough to *render* an occurrence but not enough to *address* one: Google names an occurrence
 * `<masterId>_<originalStartUtc>` and Graph gives it an opaque id, and neither is derivable from the local UID
 * alone. A mutation of one occurrence therefore resolves the provider's own instance first — patching a
 * locally conjured id could 404 or, worse, touch the wrong instance.
 *
 *  - `single` — the named occurrence only; the rest of the series is untouched;
 *  - `following` — the named occurrence and every later one. Providers have no such operation, so the series
 *    is **truncated** before the occurrence and, for an edit, the remainder is created as a new series that
 *    keeps the attendees and carries the client's new values and rule.
 *
 * Every write runs through {@link runProviderMutation}: the claim is committed before the provider call, an
 * ambiguous answer is parked rather than retried, and the caller maps the same statuses as everywhere else.
 * The local projection is not written here — the caller re-syncs the collection, so it is produced by the same
 * code the next scheduled run would use, and a scoped change cannot drift from a sync's own projection.
 */

export type OccurrenceScope = 'single' | 'following';
export type OccurrenceOperation = 'update' | 'cancel';

export interface ProviderOccurrenceTarget {
  kind: 'google' | 'graph';
  userId: string;
  connectionId: string;
  collectionId: string;
  providerCalendarId: string;
  calendarId: string;
  localEventId: string;
  /** The provider's id for the series master. */
  masterProviderId: string;
  /** The occurrence's own start, as the local `RECURRENCE-ID` carries it (`…Z`, or a date when all-day). */
  occurrenceStart: string;
  allDay: boolean;
}

/** The values a scoped edit applies. A cancel carries none. */
export interface OccurrenceEventValues {
  summary: string | null;
  description: string | null;
  location: string | null;
  url: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  attendees: string[];
  /**
   * The rule the remainder keeps, for `following`. `undefined` keeps the stored rule and `null` makes the
   * remainder a single event; an object sets it.
   */
  recurrence?: ParsedRecurrence | null;
}

export type OccurrenceWriteOutcome =
  | { status: 'confirmed'; providerOccurrenceId: string; createdSeriesId: string | null }
  | { status: 'failed'; failure: ProviderWriteFailure };

interface OccurrenceWritePayload {
  scope: OccurrenceScope;
  operation: OccurrenceOperation;
  providerCalendarId: string;
  masterId: string;
  occurrenceStart: string;
  allDay: boolean;
  /** The provider's id for the occurrence being changed. Resolved before the claim is taken. */
  occurrenceId: string;
  values?: OccurrenceEventValues;
  sendUpdates: 'none' | 'all';
}

const OCCURRENCE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The instant an occurrence's `RECURRENCE-ID` names, or midnight UTC for an all-day date. */
export function occurrenceInstant(occurrenceStart: string): Date | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(occurrenceStart)) {
    const date = new Date(`${occurrenceStart}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(occurrenceStart);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sameInstant(candidate: string | null | undefined, wanted: Date): boolean {
  if (typeof candidate !== 'string' || !candidate) return false;
  const parsed = new Date(candidate);
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() === wanted.getTime();
}

/** `YYYYMMDDTHHMMSSZ`, the form Google writes both `UNTIL` and its instance ids with. */
export function compactUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The series rule with its end moved to just before one instant.
 *
 * Providers have no "end the series before this occurrence", so the master is rewritten: `UNTIL` becomes the
 * second before the occurrence (inclusive, per RFC 5545) and any `COUNT` is dropped, because a count describes
 * the original series rather than the truncated one. Frequency, interval and by-day are preserved verbatim,
 * which is what keeps the earlier occurrences identical.
 */
export function truncateRRuleBefore(lines: readonly string[], before: Date): string[] {
  const until = compactUtc(new Date(before.getTime() - 1000));
  return lines.map(line => {
    if (!/^RRULE[;:]/i.test(line.trim())) return line;
    const body = line.trim().replace(/^RRULE:/i, '');
    const kept = body.split(';').filter(part => part && !/^COUNT=/i.test(part) && !/^UNTIL=/i.test(part));
    return `RRULE:${[...kept, `UNTIL=${until}`].join(';')}`;
  });
}

// ── Resolution of the provider's occurrence identity ─────────────────────────

/**
 * The provider's id for one occurrence, or `null` when the provider does not know it.
 *
 * A window is listed around the occurrence and the entry whose own start matches is taken. Matching on the
 * instant rather than reconstructing an id is deliberate: Google's format is documented but Graph's is opaque,
 * and an id assembled wrongly would address a different instance instead of failing.
 */
export async function resolveProviderOccurrenceId(input: {
  target: ProviderOccurrenceTarget;
  fetchImpl?: typeof fetch;
}): Promise<{ id: string; cancelled: boolean } | null> {
  const wanted = occurrenceInstant(input.target.occurrenceStart);
  if (!wanted) return null;
  const from = new Date(wanted.getTime() - OCCURRENCE_WINDOW_MS).toISOString();
  const to = new Date(wanted.getTime() + OCCURRENCE_WINDOW_MS).toISOString();
  const base = input.fetchImpl ? { fetchImpl: input.fetchImpl } : {};

  if (input.target.kind === 'google') {
    const api = { userId: input.target.userId, connectionId: input.target.connectionId, config: googleConfigFromEnv(), ...base };
    const instances = await fetchGoogleEventInstances(api, input.target.providerCalendarId, input.target.masterProviderId, { timeMin: from, timeMax: to });
    const match = instances.find(instance => {
      if (instance.originalStartTime?.date) return instance.originalStartTime.date === input.target.occurrenceStart.slice(0, 10);
      return sameInstant(instance.originalStartTime?.dateTime ?? null, wanted);
    });
    if (!match) return null;
    return { id: match.id, cancelled: match.status === 'cancelled' };
  }

  const api = { userId: input.target.userId, connectionId: input.target.connectionId, config: microsoftConfigFromEnv(), ...base };
  const instances = await fetchGraphEventInstances(api, input.target.providerCalendarId, input.target.masterProviderId, { startDateTime: from, endDateTime: to });
  const match = instances.find(instance =>
    sameInstant(instance.originalStart ?? instance.start?.dateTime ?? null, wanted)
    || (typeof instance.originalStart === 'string' && instance.originalStart.slice(0, 10) === input.target.occurrenceStart.slice(0, 10)));
  if (!match) return null;
  return { id: match.id, cancelled: match.isCancelled === true || match['@removed'] !== undefined };
}

// ── The provider payloads ────────────────────────────────────────────────────

function googleValueInput(values: OccurrenceEventValues): GoogleEventWriteInput {
  return {
    summary: values.summary,
    description: values.description,
    location: values.location,
    url: values.url,
    startsAt: values.startsAt,
    endsAt: values.endsAt,
    allDay: values.allDay,
    attendees: values.attendees,
    // Three states, exactly as the whole-series path: absent leaves the rule alone (the remainder keeps the
    // series'), `null` clears it, an object sets it. Folding undefined into `null` here would turn every
    // scoped edit into a request to end the series.
    ...(values.recurrence === undefined ? {} : { recurrence: values.recurrence }),
  };
}

function graphValueInput(values: OccurrenceEventValues): LocalEventWriteInput {
  return {
    summary: values.summary,
    description: values.description,
    location: values.location,
    url: values.url,
    startsAt: values.startsAt,
    endsAt: values.endsAt,
    allDay: values.allDay,
    attendees: values.attendees,
    ...(values.recurrence === undefined ? {} : { recurrence: values.recurrence }),
  };
}

// ── The adapters, one per provider ───────────────────────────────────────────

function googleOccurrenceAdapter(api: Parameters<typeof insertGoogleEvent>[0]): ProviderMutationAdapter<OccurrenceWritePayload, { createdSeriesId?: string | null }> {
  return {
    resourceType: 'calendar_event',
    // Applying a truncation twice, or creating the remainder twice, is not safe to replay, so a recovered
    // claim is parked — the same rule the single-event adapter states.
    idempotent: false,
    async perform(write): Promise<ProviderAdapterOutcome<{ createdSeriesId?: string | null }>> {
      try {
        if (write.scope === 'single') {
          if (write.operation === 'cancel') {
            await deleteGoogleEvent(api, write.providerCalendarId, write.occurrenceId, { sendUpdates: write.sendUpdates });
            return { status: 'committed', value: {} };
          }
          if (!write.values) return { status: 'permanent', code: 'INVALID_REQUEST' };
          await patchGoogleEvent(api, write.providerCalendarId, write.occurrenceId, googleEventPayloadFor(googleValueInput(write.values)), { sendUpdates: write.sendUpdates });
          return { status: 'committed', value: {} };
        }

        const master = await fetchGoogleEvent(api, write.providerCalendarId, write.masterId);
        if (!master) return { status: 'permanent', code: 'RESOURCE_NOT_FOUND' };
        const before = occurrenceInstant(write.occurrenceStart);
        if (!before) return { status: 'permanent', code: 'INVALID_REQUEST' };
        const existing = Array.isArray(master.recurrence) ? master.recurrence : [];
        await patchGoogleEvent(
          api,
          write.providerCalendarId,
          write.masterId,
          { recurrence: truncateRRuleBefore(existing, before) },
          { sendUpdates: write.sendUpdates },
        );
        if (write.operation === 'cancel') return { status: 'committed', value: {} };
        if (!write.values) return { status: 'permanent', code: 'INVALID_REQUEST' };

        const remainder = googleEventPayloadFor(googleValueInput(write.values));
        if (write.values.recurrence === undefined) {
          // The client changed only the occurrence and left the rule to the series: the remainder continues
          // the series, so it starts with the master's own rule (not the truncated one — the truncation
          // belongs to the part that stays behind).
          remainder.recurrence = existing;
        }
        const created = await insertGoogleEvent(api, write.providerCalendarId, remainder, { sendUpdates: write.sendUpdates });
        if (!created?.id) return { status: 'outcome_unknown', code: 'EVENT_ID_MISSING' };
        return { status: 'committed', value: { createdSeriesId: created.id } };
      } catch (error) {
        return classifyGmailMailMutationFailure(error);
      }
    },
  };
}

function graphOccurrenceAdapter(api: Parameters<typeof patchGraphEvent>[0]): ProviderMutationAdapter<OccurrenceWritePayload, { createdSeriesId?: string | null }> {
  return {
    resourceType: 'calendar_event',
    idempotent: false,
    async perform(write): Promise<ProviderAdapterOutcome<{ createdSeriesId?: string | null }>> {
      try {
        if (write.scope === 'single') {
          if (write.operation === 'cancel') {
            await deleteGraphEvent(api, write.providerCalendarId, write.occurrenceId);
            return { status: 'committed', value: {} };
          }
          if (!write.values) return { status: 'permanent', code: 'INVALID_REQUEST' };
          await patchGraphEvent(api, write.providerCalendarId, write.occurrenceId, graphEventPayloadFor(graphValueInput(write.values)));
          return { status: 'committed', value: {} };
        }

        const master = await fetchGraphEvent(api, write.providerCalendarId, write.masterId);
        if (!master) return { status: 'permanent', code: 'RESOURCE_NOT_FOUND' };
        const before = occurrenceInstant(write.occurrenceStart);
        if (!before) return { status: 'permanent', code: 'INVALID_REQUEST' };
        const pattern = master.recurrence?.pattern ?? null;
        if (!pattern) return { status: 'permanent', code: 'NOT_RECURRING' };
        const startDate = master.recurrence?.range?.startDate ?? isoDate(before);
        // Graph ends a series on a date, not at an instant, so the day before the split is the last day the
        // earlier part may produce.
        const endDate = isoDate(new Date(before.getTime() - 24 * 60 * 60 * 1000));
        await patchGraphEvent(api, write.providerCalendarId, write.masterId, {
          recurrence: { pattern, range: { type: 'endDate', startDate, endDate } },
        });
        if (write.operation === 'cancel') return { status: 'committed', value: {} };
        if (!write.values) return { status: 'permanent', code: 'INVALID_REQUEST' };

        const payload: GraphEventPayload = graphEventPayloadFor(graphValueInput(write.values));
        if (write.values.recurrence) {
          payload.recurrence = graphRecurrenceFromStructure(write.values.recurrence, write.values.startsAt);
        } else if (write.values.recurrence === null) {
          payload.recurrence = null;
        } else if (master.recurrence) {
          // No rule from the client: the remainder continues the series with the master's own rule.
          payload.recurrence = { pattern, range: master.recurrence.range ?? { type: 'noEnd', startDate } };
        }
        const created = await createGraphEvent(api, write.providerCalendarId, payload);
        if (!created?.id) return { status: 'outcome_unknown', code: 'EVENT_ID_MISSING' };
        return { status: 'committed', value: { createdSeriesId: created.id } };
      } catch (error) {
        return classifyGmailMailMutationFailure(error);
      }
    },
  };
}

// ── The entry point ──────────────────────────────────────────────────────────

export async function writeProviderCalendarOccurrence(input: {
  target: ProviderOccurrenceTarget;
  scope: OccurrenceScope;
  operation: OccurrenceOperation;
  values?: OccurrenceEventValues;
  sendUpdates: 'none' | 'all';
  idempotencyKey?: string | null;
  /** Injected in tests so the journal and the route can be exercised without a provider. */
  fetchImpl?: typeof fetch;
}): Promise<OccurrenceWriteOutcome> {
  const occurrence = await resolveProviderOccurrenceId({ target: input.target, ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) });
  if (!occurrence) {
    return {
      status: 'failed',
      failure: {
        status: 409,
        code: 'OCCURRENCE_NOT_FOUND',
        error: 'This occurrence is not in the provider\u2019s series yet. Refresh the calendar and try again.',
      },
    };
  }

  const payload: OccurrenceWritePayload = {
    scope: input.scope,
    operation: input.operation,
    providerCalendarId: input.target.providerCalendarId,
    masterId: input.target.masterProviderId,
    occurrenceStart: input.target.occurrenceStart,
    allDay: input.target.allDay,
    occurrenceId: occurrence.id,
    ...(input.values ? { values: input.values } : {}),
    sendUpdates: input.sendUpdates,
  };

  const base = input.fetchImpl ? { fetchImpl: input.fetchImpl } : {};
  const adapter = input.target.kind === 'google'
    ? googleOccurrenceAdapter({ userId: input.target.userId, connectionId: input.target.connectionId, config: googleConfigFromEnv(), ...base })
    : graphOccurrenceAdapter({ userId: input.target.userId, connectionId: input.target.connectionId, config: microsoftConfigFromEnv(), ...base });

  const result = await runProviderMutation(
    {
      userId: input.target.userId,
      channel: 'web',
      operation: input.operation === 'cancel' ? 'delete' : 'update',
      connectionId: input.target.connectionId,
      collectionId: input.target.collectionId,
      resourceId: input.target.localEventId,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      payload,
      timeoutMs: 20_000,
    },
    adapter,
  );
  if (result.status !== 'confirmed') return { status: 'failed', failure: providerWriteFailure(result) };
  return {
    status: 'confirmed',
    providerOccurrenceId: occurrence.id,
    createdSeriesId: result.value?.createdSeriesId ?? null,
  };
}
