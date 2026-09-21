import ICAL from 'ical.js';
import { googleConfigFromEnv, microsoftConfigFromEnv } from './providerAuthService.js';
import { runProviderMutation } from './providerMutationService.js';
import type { ProviderAdapterOutcome, ProviderMutationAdapter } from './providerMutationService.js';
import type { OperationProgressEntry } from './providerOperations.js';
import { fetchCalendarEvents } from './providers/google/googleCalendar.js';
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
  graphRecurrenceRule,
  listGraphCalendarEvents,
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
/**
 * The fallback window used when the narrow one lists no match (CAL-04).
 *
 * A listing is filtered by an instance's **current** start, and an exception can be moved arbitrarily far from
 * the original occurrence; assuming a one-day displacement meant an exception moved by a week was never found
 * and the edit was answered `OCCURRENCE_NOT_FOUND`. The wider window is bounded and only consulted after the
 * narrow one found nothing, so ordinary edits still cost one request.
 */
const OCCURRENCE_WIDE_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

/** Parse a Graph stamp with no offset as UTC instead of letting `new Date` assume the server's zone (CAL-04). */
function graphInstant(value: string | null | undefined): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const normalised = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  const parsed = new Date(normalised);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The instance whose `originalStartTime` is the occurrence the user acted on. */
function googleInstanceMatches(
  instance: { originalStartTime?: { date?: string | null; dateTime?: string | null } | null },
  target: ProviderOccurrenceTarget,
  wanted: Date,
): boolean {
  if (instance.originalStartTime?.date) {
    // A date-only comparison is only meaningful for an all-day occurrence; applying it to a timed one matched
    // any instance on the same day regardless of its time (CAL-04).
    return target.allDay && instance.originalStartTime.date === target.occurrenceStart.slice(0, 10);
  }
  return sameInstant(instance.originalStartTime?.dateTime ?? null, wanted);
}

/** The Graph instance whose `originalStart` is the occurrence the user acted on. */
function graphInstanceMatches(
  instance: { originalStart?: string | null; start?: { dateTime?: string | null } | null },
  target: ProviderOccurrenceTarget,
  wanted: Date,
): boolean {
  const original = graphInstant(instance.originalStart ?? null);
  if (original && original.getTime() === wanted.getTime()) return true;
  if (!instance.originalStart && !target.allDay) {
    // No `originalStart` means Graph returned the instance's own start; it carries no offset, so it is read as
    // UTC rather than in the server's local zone.
    return graphInstant(instance.start?.dateTime ?? null)?.getTime() === wanted.getTime();
  }
  // Date-only, and only for an all-day occurrence (CAL-04).
  return target.allDay && typeof instance.originalStart === 'string'
    && instance.originalStart.slice(0, 10) === target.occurrenceStart.slice(0, 10);
}

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

/**
 * Whether two provider stamps name the same moment.
 *
 * The payload a create sent and the resource the provider answers with are the same instant written differently —
 * Graph pads fractional seconds (`…T11:00:00.0000000`) where the request carried `…T11:00:00` — so a comparison by
 * string would never recognise the remainder a split had already created. A stamp without a zone designator is read
 * as UTC, the frame the provider listing is requested in.
 */
function sameStamp(candidate: string | null | undefined, wanted: string | null | undefined): boolean {
  const normalize = (value: string | null | undefined): number | null => {
    if (typeof value !== 'string' || !value) return null;
    const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
    const parsed = new Date(withZone);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  };
  const left = normalize(candidate);
  const right = normalize(wanted);
  if (left !== null && right !== null) return left === right;
  return (candidate ?? null) === (wanted ?? null);
}

/** `YYYYMMDDTHHMMSSZ`, the form Google writes both `UNTIL` and its instance ids with. */
export function compactUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The calendar date of an instant in a series' own time zone, as `YYYY-MM-DD` (CAL-03). */
function localDateInZone(instant: Date, timeZone: string | null | undefined): string {
  if (!timeZone) return isoDate(instant);
  try {
    // `en-CA` is the locale whose short date is already `YYYY-MM-DD`.
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
  } catch {
    // An unknown zone is not a reason to refuse: fall back to UTC, which is what the code did before.
    return isoDate(instant);
  }
}

/** The day before a `YYYY-MM-DD` date, by calendar arithmetic with no time-zone conversion. */
function previousIsoDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const utc = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1) - 24 * 60 * 60 * 1000;
  return new Date(utc).toISOString().slice(0, 10);
}

/**
 * The series rule with its end moved to just before one instant.
 *
 * Providers have no "end the series before this occurrence", so the master is rewritten: `UNTIL` becomes the
 * second before the occurrence (inclusive, per RFC 5545) and any `COUNT` is dropped, because a count describes
 * the original series rather than the truncated one. Frequency, interval and by-day are preserved verbatim,
 * which is what keeps the earlier occurrences identical.
 *
 * The `UNTIL` **value type follows DTSTART** (CAL-03): an all-day series has a `DATE` DTSTART, and RFC 5545
 * requires a `DATE` UNTIL for it — a UTC `DATE-TIME` there is invalid, and the day it names is the previous
 * *date*, not the instant a second earlier.
 */
export function truncateRRuleBefore(
  lines: readonly string[],
  before: Date,
  options: { startIsDate?: boolean } = {},
): string[] {
  const until = options.startIsDate
    ? `UNTIL=${previousIsoDate(isoDate(before)).replace(/-/g, '')}`
    : `UNTIL=${compactUtc(new Date(before.getTime() - 1000))}`;
  return lines.map(line => {
    if (!/^RRULE[;:]/i.test(line.trim())) return line;
    const body = line.trim().replace(/^RRULE:/i, '');
    const kept = body.split(';').filter(part => part && !/^COUNT=/i.test(part) && !/^UNTIL=/i.test(part));
    return `RRULE:${[...kept, until].join(';')}`;
  });
}

/**
 * How many occurrences a rule produces strictly before `before`, counted from `dtstart`.
 *
 * `null` when the rule cannot be expanded safely (unparseable, or more occurrences than the safety limit), so
 * the caller refuses the split rather than guessing a count.
 */
export function occurrencesBeforeRule(rrule: string, dtstart: string, before: Date, limit = 500): number | null {
  let rule: ICAL.Recur;
  let start: ICAL.Time;
  try {
    rule = ICAL.Recur.fromString(rrule.replace(/^RRULE:/i, ''));
    start = /^\d{4}-\d{2}-\d{2}$/.test(dtstart) ? ICAL.Time.fromDateString(dtstart) : ICAL.Time.fromString(dtstart, null);
  } catch {
    return null;
  }
  let iterator: ICAL.RecurIterator;
  try {
    iterator = rule.iterator(start);
  } catch {
    return null;
  }
  let count = 0;
  for (let index = 0; index < limit; index += 1) {
    const next = iterator.next();
    if (!next) return count;
    if (next.toJSDate().getTime() >= before.getTime()) return count;
    count += 1;
  }
  return null;
}

/**
 * The rule the remainder of a split series should carry.
 *
 * A `COUNT` copied verbatim restarts the whole series, so the remainder keeps only the occurrences the earlier
 * part does not: a series of 10 split at the 4th keeps 3 behind and continues with 7 (CAL-02). An `UNTIL`-based
 * or unbounded rule is already correct for the remainder and is returned unchanged. `null` means the
 * continuation cannot be represented and the caller must refuse before writing anything.
 */
export function continueRruleAfterSplit(rrule: string, dtstart: string, before: Date): string | null {
  let rule: ICAL.Recur;
  try {
    rule = ICAL.Recur.fromString(rrule.replace(/^RRULE:/i, ''));
  } catch {
    return null;
  }
  if (rule.count === null || rule.count === undefined) return rule.toString();
  const consumed = occurrencesBeforeRule(rrule, dtstart, before);
  if (consumed === null) return null;
  const remaining = rule.count - consumed;
  if (remaining <= 0) return null;
  const continued = rule.clone();
  continued.count = remaining;
  return continued.toString();
}

/**
 * How many occurrences a series' own rule places strictly before the split (CAL-02), or null when the rule
 * cannot be expanded safely.
 */
function occurrencesBeforeSplit(rule: string | null, dtstart: string | null, before: Date): number | null {
  if (!rule || !dtstart) return null;
  return occurrencesBeforeRule(rule.trim().replace(/^RRULE[;:]/i, ''), dtstart, before);
}

/**
 * What a `COUNT` becomes on the remainder: unchanged when there is none, the reduced number when it can be
 * derived, and `unsupported` when it cannot.
 *
 * The composer sends the **series'** rule for "this and following" — it copies the series' recurrence into the
 * form — so a client-supplied `COUNT` is the whole series' count, not the remainder's. Creating the remainder
 * with it verbatim restarts the series from the split, which is the CAL-02 defect reached from the client rather
 * than from the master. An `UNTIL` is absolute and is already correct for the remainder.
 */
function continuedCount(total: number | null | undefined, consumed: number | null):
  | { kind: 'unchanged' }
  | { kind: 'count'; count: number }
  | { kind: 'unsupported' } {
  if (total === null || total === undefined) return { kind: 'unchanged' };
  if (consumed === null) return { kind: 'unsupported' };
  const remaining = total - consumed;
  return remaining > 0 ? { kind: 'count', count: remaining } : { kind: 'unsupported' };
}

/**
 * How many of a calendar's events look like the remainder a split dispatched (CAL-01).
 *
 * The create goes straight to the provider, so a run that died after dispatching it left no record of whether it
 * landed — and creating it again would make a second series. This is how the ambiguity is resolved: look for an
 * event that carries exactly what the split was about to create, and act on what is found.
 *
 * Only a single exact match counts. **Absent** means the create did not land (or the event was removed since), and
 * **ambiguous** means more than one event matches — two identical events can legitimately exist, and linking the
 * wrong one would be worse than reporting that a person has to look.
 */
export function matchSplitRemainder(
  events: ReadonlyArray<{
    id?: string | null;
    summary?: string | null;
    start?: { dateTime?: string | null; date?: string | null } | null;
    recurrence?: string[] | null;
  }>,
  signature: { id: string; summary: string; start: { dateTime: string | null; date: string | null }; recurrence: string[] },
): { verdict: 'found'; id: string } | { verdict: 'absent' } | { verdict: 'ambiguous' } {
  const matches = events.filter(event => {
    // The master itself is never the remainder, even when the two look alike.
    if (!event.id || event.id === signature.id) return false;
    if ((event.summary ?? null) !== signature.summary) return false;
    if (!sameStamp(event.start?.dateTime ?? null, signature.start.dateTime)) return false;
    // An all-day series has a date and no time, and its date is compared literally.
    if ((event.start?.date ?? null) !== signature.start.date) return false;
    const recurrence = Array.isArray(event.recurrence) ? event.recurrence : [];
    return recurrence.length === signature.recurrence.length
      && recurrence.every((line, index) => line === signature.recurrence[index]);
  });
  if (matches.length === 0) return { verdict: 'absent' };
  // The matcher answers with the id it matched: re-finding the same event afterwards is how the two comparisons
  // drift apart (the first compared instants, the second compared strings, and they disagreed).
  return matches.length === 1 ? { verdict: 'found', id: matches[0]!.id as string } : { verdict: 'ambiguous' };
}

/**
 * The outcome a resumed run already reached, when its own record says the remainder exists.
 *
 * Returning it without touching the provider is what keeps a reclaimed operation from creating a second series.
 */
function resumedOutcome(context: { progress?: OperationProgressEntry[] } | undefined): ProviderAdapterOutcome<{ createdSeriesId?: string | null }> | null {
  const created = context?.progress?.find(entry => entry.stage === 'remainder_created');
  const createdSeriesId = (created?.detail as { createdSeriesId?: string } | undefined)?.createdSeriesId;
  return createdSeriesId ? { status: 'committed', value: { createdSeriesId } } : null;
}

/** What a resumed run must not repeat, and the snapshot the remainder is built from. */
function resumedSplit(context: { progress?: OperationProgressEntry[] } | undefined): {
  masterTruncated: boolean;
  createDispatched: boolean;
  remainderCreated: boolean;
  prepared: Record<string, unknown> | null;
} | null {
  const stages = context?.progress ?? [];
  const truncated = stages.some(entry => entry.stage === 'master_truncated');
  if (!truncated) return null;
  const prepared = stages.find(entry => entry.stage === 'split_prepared')?.detail;
  return {
    masterTruncated: true,
    createDispatched: stages.some(entry => entry.stage === 'remainder_create_dispatched'),
    remainderCreated: stages.some(entry => entry.stage === 'remainder_created'),
    prepared: (prepared as Record<string, unknown> | undefined) ?? null,
  };
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
  const base = input.fetchImpl ? { fetchImpl: input.fetchImpl } : {};

  if (input.target.kind === 'google') {
    const api = { userId: input.target.userId, connectionId: input.target.connectionId, config: googleConfigFromEnv(), ...base };
    const list = (windowMs: number) => fetchGoogleEventInstances(api, input.target.providerCalendarId, input.target.masterProviderId, {
      timeMin: new Date(wanted.getTime() - windowMs).toISOString(),
      timeMax: new Date(wanted.getTime() + windowMs).toISOString(),
    });
    // The narrow window first; the wider one only when it found nothing, so an exception moved far from its
    // original occurrence is still found (CAL-04).
    const narrow = await list(OCCURRENCE_WINDOW_MS);
    const match = narrow.find(instance => googleInstanceMatches(instance, input.target, wanted))
      ?? (await list(OCCURRENCE_WIDE_WINDOW_MS)).find(instance => googleInstanceMatches(instance, input.target, wanted));
    if (!match) return null;
    return { id: match.id, cancelled: match.status === 'cancelled' };
  }

  const api = { userId: input.target.userId, connectionId: input.target.connectionId, config: microsoftConfigFromEnv(), ...base };
  const list = (windowMs: number) => fetchGraphEventInstances(api, input.target.providerCalendarId, input.target.masterProviderId, {
    startDateTime: new Date(wanted.getTime() - windowMs).toISOString(),
    endDateTime: new Date(wanted.getTime() + windowMs).toISOString(),
  });
  const narrow = await list(OCCURRENCE_WINDOW_MS);
  const match = narrow.find(instance => graphInstanceMatches(instance, input.target, wanted))
    ?? (await list(OCCURRENCE_WIDE_WINDOW_MS)).find(instance => graphInstanceMatches(instance, input.target, wanted));
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
    // Applying a truncation twice, or creating the remainder twice, is not safe to replay, so a recovered claim is
    // parked **unless** the operation recorded how far it got: then the remaining step can be finished from that
    // record instead of repeating both writes (CAL-01).
    idempotent: false,
    resumeFrom: progress => Boolean(
      progress.some(entry => entry.stage === 'master_truncated')
      && progress.some(entry => entry.stage === 'split_prepared'),
    ),
    async perform(write, context): Promise<ProviderAdapterOutcome<{ createdSeriesId?: string | null }>> {
      if (resumedOutcome(context)) return resumedOutcome(context) as ProviderAdapterOutcome<{ createdSeriesId?: string | null }>;
      const resumed = resumedSplit(context);
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
        // A split at the first occurrence has an empty prefix, and RFC 5545 has no valid rule for it: the
        // operation is the whole series. Refuse before writing rather than storing `UNTIL` before `DTSTART`
        // (CAL-03).
        const seriesStart = master.start ? occurrenceInstant(master.start.dateTime ?? master.start.date ?? '') : null;
        if (seriesStart && before.getTime() <= seriesStart.getTime()) {
          return { status: 'permanent', code: 'SPLIT_AT_FIRST_OCCURRENCE' };
        }
        const existing = Array.isArray(master.recurrence) ? master.recurrence : [];
        // An all-day series has a DATE DTSTART, so its UNTIL must be a DATE too (CAL-03).
        const startIsDate = Boolean(master.start?.date && !master.start?.dateTime);
        // CAL-01: everything the two writes need is validated and built **before** the first one. The master
        // used to be truncated and only then was the payload inspected, so a missing `values` (or a payload that
        // could not be built) left a truncated series with no remainder.
        if (write.operation !== 'cancel' && !write.values) {
          return { status: 'permanent', code: 'INVALID_REQUEST' };
        }
        const masterRuleLine = existing.find(line => /^RRULE[;:]/i.test(line.trim())) ?? null;
        const masterDtstart = master.start?.date ?? master.start?.dateTime ?? null;
        // A client-supplied rule for the remainder is the **series'** rule (the composer copies it), so its COUNT
        // is continued rather than restarted; an unrepresentable one refuses before anything is written (CAL-02).
        let writeValues = write.values ?? null;
        const clientRecurrence = writeValues?.recurrence ?? null;
        if (clientRecurrence) {
          const outcome = continuedCount(clientRecurrence.count, occurrencesBeforeSplit(masterRuleLine, masterDtstart, before));
          if (outcome.kind === 'unsupported') return { status: 'permanent', code: 'RECURRENCE_CONTINUATION_UNSUPPORTED' };
          if (outcome.kind === 'count' && writeValues) {
            writeValues = { ...writeValues, recurrence: { ...clientRecurrence, count: outcome.count } };
          }
        }
        const remainder = writeValues ? googleEventPayloadFor(googleValueInput(writeValues)) : null;
        // The remainder's rule is computed before any write. A `COUNT` copied verbatim would start the whole
        // count again from the split, so a series of 10 split at the 4th would end with 13 occurrences (CAL-02);
        // when the continuation cannot be represented the write refuses instead of truncating the master and
        // leaving a remainder that restarts the series.
        const needsContinuation = write.operation !== 'cancel' && clientRecurrence === null;
        let remainderRecurrence: string[] | null = null;
        if (needsContinuation) {
          if (!masterRuleLine || !masterDtstart) return { status: 'permanent', code: 'RECURRENCE_CONTINUATION_UNSUPPORTED' };
          const continued = continueRruleAfterSplit(masterRuleLine.trim().replace(/^RRULE:/i, ''), masterDtstart, before);
          if (!continued) return { status: 'permanent', code: 'RECURRENCE_CONTINUATION_UNSUPPORTED' };
          remainderRecurrence = existing.map(line => (line === masterRuleLine ? `RRULE:${continued}` : line));
        }
        // CAL-01: the whole intent is recorded **before** the first write, so a run that dies between the two
        // writes leaves everything the remainder needs — the series, the split point and the payload — rather than
        // a bare "in flight" that a later claim can only park as unknown.
        await context?.recordProgress?.('split_prepared', {
          masterId: write.masterId,
          occurrenceStart: write.occurrenceStart,
          scope: write.scope,
          operation: write.operation,
          remainderRecurrence,
          values: writeValues,
        });
        // A resumed run already truncated the master: repeating it would re-derive the same truncation, but the
        // record is the authority on what happened, so the write is skipped entirely.
        if (!resumed?.masterTruncated) {
          await patchGoogleEvent(
            api,
            write.providerCalendarId,
            write.masterId,
            { recurrence: truncateRRuleBefore(existing, before, { startIsDate }) },
            { sendUpdates: write.sendUpdates },
          );
          await context?.recordProgress?.('master_truncated', { masterId: write.masterId, occurrenceStart: write.occurrenceStart });
        }
        if (write.operation === 'cancel' || !remainder) return { status: 'committed', value: {} };

        if (remainderRecurrence) {
          // The remainder continues the series with the master's own rule adjusted for what the earlier part
          // keeps — not the truncated one, and not the original count either (CAL-02).
          remainder.recurrence = remainderRecurrence;
        }
        // CAL-01: a resumed run whose record shows the create was dispatched but not its answer must not dispatch a
        // second one blindly. The calendar is asked whether the remainder is already there, and only an exact,
        // single match is treated as landed; nothing found means the create did not land, and more than one means a
        // person has to look — creating on that ambiguity could duplicate a series.
        const reconcile = resumed?.createDispatched && !resumed.remainderCreated;
        if (reconcile) {
          const signature = {
            id: write.masterId,
            summary: remainder.summary ?? '',
            start: { dateTime: remainder.start?.dateTime ?? null, date: remainder.start?.date ?? null },
            recurrence: remainder.recurrence ?? [],
          };
          const page = await fetchCalendarEvents(api, write.providerCalendarId, {
            timeMin: new Date(before.getTime() - 86_400_000).toISOString(),
            timeMax: new Date(before.getTime() + 86_400_000).toISOString(),
            maxResults: 250,
          });
          const match = matchSplitRemainder(page.events, signature);
          if (match.verdict === 'ambiguous') {
            return { status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' };
          }
          if (match.verdict === 'found') {
            await context?.recordProgress?.('remainder_created', { createdSeriesId: match.id, reconciled: true });
            return { status: 'committed', value: { createdSeriesId: match.id } };
          }
        }
        // The create goes straight to the API (no journal of its own), so this record is the only evidence that it
        // was dispatched. A run that dies here cannot be resumed safely — a second create would make a second
        // series — so the record exists to make that state explicit instead of a generic unknown (CAL-01).
        await context?.recordProgress?.('remainder_create_dispatched', { occurrenceStart: write.occurrenceStart });
        const created = await insertGoogleEvent(api, write.providerCalendarId, remainder, { sendUpdates: write.sendUpdates });
        if (!created?.id) return { status: 'outcome_unknown', code: 'EVENT_ID_MISSING' };
        await context?.recordProgress?.('remainder_created', { createdSeriesId: created.id });
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
    resumeFrom: progress => Boolean(
      progress.some(entry => entry.stage === 'master_truncated')
      && progress.some(entry => entry.stage === 'split_prepared'),
    ),
    async perform(write, context): Promise<ProviderAdapterOutcome<{ createdSeriesId?: string | null }>> {
      if (resumedOutcome(context)) return resumedOutcome(context) as ProviderAdapterOutcome<{ createdSeriesId?: string | null }>;
      const resumed = resumedSplit(context);
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
        const startDate = master.recurrence?.range?.startDate ?? localDateInZone(before, master.start?.timeZone);
        // The earlier part may produce occurrences before the split, so it ends on the previous **calendar day
        // in the series' own zone** — not on the previous UTC day, which is off by one for any series whose zone
        // is ahead of UTC (a 00:30 Europe/Warsaw occurrence already sits on the previous UTC date) (CAL-03).
        const splitDate = localDateInZone(before, master.start?.timeZone);
        const endDate = previousIsoDate(splitDate);
        // A split at the first occurrence has an empty prefix and Graph would reject the range (or, worse,
        // accept a range that ends before it starts). Refuse before writing anything (CAL-03).
        if (endDate < startDate) return { status: 'permanent', code: 'SPLIT_AT_FIRST_OCCURRENCE' };
        // The remainder's range is computed **before** any write (CAL-02): it must start at the split and, for a
        // numbered series, continue with only the occurrences the earlier part does not keep — otherwise the
        // whole count restarts from the split. An unrepresentable continuation refuses instead of writing.
        const needsContinuation = write.operation !== 'cancel' && write.values?.recurrence === undefined;
        let remainderRange: NonNullable<GraphEventPayload['recurrence']>['range'] | null = null;
        if (needsContinuation) {
          const range = master.recurrence?.range;
          if (range?.type === 'numbered') {
            const dtstart = master.start?.dateTime ?? null;
            const rule = graphRecurrenceRule(pattern, range);
            const total = range.numberOfOccurrences ?? null;
            const consumed = rule && dtstart ? occurrencesBeforeRule(rule, dtstart, before) : null;
            if (consumed === null || total === null) return { status: 'permanent', code: 'RECURRENCE_CONTINUATION_UNSUPPORTED' };
            const remaining = total - consumed;
            if (remaining <= 0) return { status: 'permanent', code: 'RECURRENCE_CONTINUATION_UNSUPPORTED' };
            remainderRange = { type: 'numbered', startDate: splitDate, numberOfOccurrences: remaining };
          } else {
            remainderRange = { ...(range ?? { type: 'noEnd' }), startDate: splitDate };
          }
        }
        // CAL-01: the remainder payload is built **before** the master is truncated, so a missing `values` or a
        // payload that cannot be built refuses with nothing written, instead of leaving a truncated series.
        if (write.operation !== 'cancel' && !write.values) {
          return { status: 'permanent', code: 'INVALID_REQUEST' };
        }
        let payload: GraphEventPayload | null = null;
        if (write.values) {
          payload = graphEventPayloadFor(graphValueInput(write.values));
          if (write.values.recurrence) {
            payload.recurrence = graphRecurrenceFromStructure(write.values.recurrence, write.values.startsAt);
            // CAL-02: the client sends the **series'** rule for "this and following", so a numbered range it
            // supplies is the series' count and must lose the occurrences the earlier part keeps; otherwise the
            // remainder restarts the whole series from the split. An unrepresentable one refuses here, before the
            // master is truncated, rather than leaving the two halves disagreeing about how many times it repeats.
            const suppliedRange = payload.recurrence?.range ?? null;
            if (suppliedRange?.type === 'numbered') {
              const masterRange = master.recurrence?.range ?? null;
              const consumed = masterRange
                ? occurrencesBeforeSplit(graphRecurrenceRule(pattern, masterRange), master.start?.dateTime ?? null, before)
                : null;
              const outcome = continuedCount(suppliedRange.numberOfOccurrences ?? null, consumed);
              if (outcome.kind === 'unsupported') return { status: 'permanent', code: 'RECURRENCE_CONTINUATION_UNSUPPORTED' };
              if (outcome.kind === 'count') {
                payload.recurrence = { ...payload.recurrence!, range: { ...suppliedRange, numberOfOccurrences: outcome.count } };
              }
            }
          } else if (write.values.recurrence === null) {
            payload.recurrence = null;
          } else if (master.recurrence) {
            payload.recurrence = { pattern, range: remainderRange ?? { ...(master.recurrence.range ?? { type: 'noEnd' }), startDate: splitDate } };
          }
        }
        // CAL-01: a resumed run whose record shows the create was dispatched but not its answer asks the calendar
        // first, exactly as the Google path does — an exact, single match means it landed.
        const reconcile = resumed?.createDispatched && !resumed.remainderCreated;
        if (reconcile && payload) {
          const expected = payload;
          const listed = await listGraphCalendarEvents(api, write.providerCalendarId);
          const match = matchSplitRemainder(
            listed.map(event => ({
              id: event.id,
              summary: event.subject ?? null,
              start: { dateTime: event.start?.dateTime ?? null, date: null },
              recurrence: event.recurrence ? graphRecurrenceRule(event.recurrence.pattern, event.recurrence.range) ? [graphRecurrenceRule(event.recurrence.pattern, event.recurrence.range) as string] : [] : [],
            })),
            {
              id: write.masterId,
              summary: expected.subject ?? '',
              start: { dateTime: expected.start?.dateTime ?? null, date: null },
              recurrence: expected.recurrence ? [graphRecurrenceRule(expected.recurrence.pattern, expected.recurrence.range) as string] : [],
            },
          );
          if (match.verdict === 'ambiguous') return { status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' };
          if (match.verdict === 'found') {
            await context?.recordProgress?.('remainder_created', { createdSeriesId: match.id, reconciled: true });
            return { status: 'committed', value: { createdSeriesId: match.id } };
          }
        }
        // CAL-01: as on Google, everything the remainder needs is recorded before the first write.
        await context?.recordProgress?.('split_prepared', {
          masterId: write.masterId,
          occurrenceStart: write.occurrenceStart,
          scope: write.scope,
          operation: write.operation,
          payload: payload ?? null,
        });
        // The record is the authority: a resumed run does not repeat a truncation it already completed.
        if (!resumed?.masterTruncated) {
          await patchGraphEvent(api, write.providerCalendarId, write.masterId, {
            recurrence: { pattern, range: { type: 'endDate', startDate, endDate } },
          });
          await context?.recordProgress?.('master_truncated', { masterId: write.masterId, occurrenceStart: write.occurrenceStart });
        }
        // A resumed run creates the remainder from the snapshot it recorded before the first write, not from a
        // rebuild: that snapshot is what the operation declared it would create.
        const recordedPayload = (resumed?.prepared as { payload?: GraphEventPayload | null } | undefined)?.payload ?? null;
        if (resumed?.masterTruncated && recordedPayload) payload = recordedPayload;
        if (write.operation === 'cancel' || !payload) return { status: 'committed', value: {} };

        await context?.recordProgress?.('remainder_create_dispatched', { occurrenceStart: write.occurrenceStart });
        const created = await createGraphEvent(api, write.providerCalendarId, payload);
        if (!created?.id) return { status: 'outcome_unknown', code: 'EVENT_ID_MISSING' };
        await context?.recordProgress?.('remainder_created', { createdSeriesId: created.id });
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
