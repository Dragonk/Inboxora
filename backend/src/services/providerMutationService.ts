import { withTransaction } from './db.js';
import { beginOperation, completeOperation, recordOperationProgress, scheduleOperationRetry } from './providerOperations.js';
import type { OperationProgressEntry } from './providerOperations.js';
import type { ProviderOperationStatus } from './providerOperations.js';
import type { ProviderOperation } from './providers/contracts.js';

/**
 * The shared provider-mutation layer (v4 plan §5.1, §8.3, §22.2–22.4).
 *
 * Mail, calendar and contacts adapters implement their own network calls, but the
 * semantics above them are one contract, because the traps are the same in all
 * three: a retry must not duplicate a mutation whose outcome is unknown, an
 * identical intent must replay instead of executing twice, and a worker that lost
 * its claim must not report success.
 *
 * The rule that makes "a failure between the provider and PostgreSQL cannot cause
 * an automatic double execution" true is an **ordering**: the claim is written and
 * *committed* before the provider call starts, and the terminal state is recorded
 * afterwards in a separate transaction. If the process dies between the two, the
 * journal holds an `in_flight` claim with an unexpired lease — not a rolled-back
 * claim that a retry would re-run as if nothing had happened. When such a claim is
 * recovered, {@link reclaimDecision} decides whether re-running is safe:
 *
 *  - an **idempotent** operation (setting a flag to a value, upserting a resource)
 *    is re-run, because doing so converges on the same state;
 *  - a **non-idempotent** operation (sending a message, creating a resource) is
 *    parked as `outcome_unknown` and never re-run automatically, because the
 *    previous owner may have dispatched it.
 *
 * Adapters classify their own failures. The classification is part of the
 * contract, not an implementation detail: `retryable` asserts that the provider
 * did **not** apply the change (so a retry is safe), while `outcome_unknown` means
 * it may have (so nothing automatic follows). An unclassified throw is treated as
 * `outcome_unknown`, which is the conservative direction.
 */

/** What an adapter reports. Every status maps to one shared mutation status. */
export type ProviderAdapterOutcome<T = unknown> =
  | { status: 'committed'; value?: T }
  | { status: 'accepted_pending'; value?: T }
  | { status: 'conflict'; code?: string; value?: T }
  | { status: 'retryable'; code?: string; retryAfterSeconds?: number }
  | { status: 'permanent'; code: string }
  | { status: 'outcome_unknown'; code?: string };

export interface ProviderMutationAdapter<TPayload, TResult = unknown> {
  /** Journal `resource_type`, e.g. `message`, `calendar_event`, `contact`. */
  resourceType: string;
  /**
   * Whether re-running `perform` after an unconfirmed attempt is safe. See the
   * module comment: this is what {@link reclaimDecision} keys on.
   */
  idempotent: boolean;
  /** The provider call. It must classify its own failures. */
  perform(payload: TPayload, context: ProviderMutationContext): Promise<ProviderAdapterOutcome<TResult>>;
  /**
   * Whether this adapter can continue a reclaimed operation from the stages it recorded (CAL-01).
   *
   * Only an adapter that writes in steps *and* records each of them can answer yes: it must know which of its
   * writes the record shows as done, so resuming does not repeat one. The default — no method at all — keeps the
   * conservative park.
   */
  resumeFrom?(progress: OperationProgressEntry[]): boolean;
}

export interface ProviderMutationContext {
  operationId: string;
  /** Aborted when the request's `timeoutMs` elapses. */
  signal: AbortSignal;
  /**
   * Record a completed stage of a multi-write operation, durably (CAL-01).
   *
   * A change that spans two provider writes can die between them; without this the journal knew only that the
   * operation had started. An adapter calls it after each write it completes, with the data the next step needs.
   *
   * Optional so a test double can build a context from just an id and a signal; the service that runs an adapter
   * always supplies it, and an adapter must therefore call it as `context.recordProgress?.(…)`.
   */
  recordProgress?(stage: string, detail?: unknown): Promise<void>;
  /**
   * The stages a reclaimed operation already completed, empty for a fresh one.
   *
   * An adapter that resumes reads them to skip the writes the record shows as done.
   */
  progress?: OperationProgressEntry[];
}

export interface ProviderMutationRequest<TPayload> {
  userId: string;
  channel: 'web' | 'dav' | 'worker' | 'plugin';
  operation: ProviderOperation;
  accountId?: string | null;
  connectionId?: string | null;
  collectionId?: string | null;
  resourceId?: string | null;
  /**
   * Stable key of one logical intent. Omit it for an action that is inherently a
   * new intent each time; the journal still records and fences the attempt, but
   * two calls are two operations.
   */
  idempotencyKey?: string | null;
  /** Fingerprint of the intent; the same key with a different hash is a conflict. */
  payloadHash?: string | null;
  payload: TPayload;
  expectedVersions?: Record<string, unknown>;
  leaseSeconds?: number;
  owner?: string | null;
  /** Aborts the provider call after this long. Omitted means no deadline. */
  timeoutMs?: number;
  /** Backoff for a `retryable` outcome. Omitted means `retryable` is reported but not scheduled. */
  retry?: { delaySeconds: number };
}

/** The shared vocabulary the callers (routes, plugins, workers) switch on. */
export type ProviderMutationStatus =
  | 'confirmed'
  | 'accepted'
  | 'pending'
  | 'retryable'
  | 'conflict'
  | 'permanent'
  | 'outcome_unknown';

export interface ProviderMutationResult<T = unknown> {
  status: ProviderMutationStatus;
  operationId: string | null;
  value?: T;
  code?: string;
  retryAfterSeconds?: number;
  /** True when the journal answered from a previous attempt instead of performing one. */
  replayed: boolean;
  /**
   * The stages this operation recorded, when any (CAL-01).
   *
   * An operation parked as an unknown outcome because its adapter cannot resume still reports what it knows here:
   * "the remainder create was dispatched" is a different, actionable state from "the operation started", and this
   * is what tells them apart without reading the journal by hand.
   */
  progress?: OperationProgressEntry[];
}

/** The statuses a finished operation can be in when it is read back. */
const REPLAY_STATUS: Readonly<Record<ProviderOperationStatus, ProviderMutationStatus>> = Object.freeze({
  committed: 'confirmed',
  accepted_pending: 'accepted',
  outcome_unknown: 'outcome_unknown',
  conflict: 'conflict',
  failed: 'permanent',
  cancelled: 'permanent',
  pending: 'retryable',
  in_flight: 'pending',
});

function codeFrom(error: unknown): string {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === 'string' && value ? value : 'MUTATION_OUTCOME_UNKNOWN';
}

/**
 * Whether a recovered claim may run the provider call again. Exported because it
 * is the decision the whole layer exists to make, and it is worth asserting
 * directly rather than only through a database round trip.
 */
export function reclaimDecision(reclaimed: boolean, idempotent: boolean, resumable = false): 'run' | 'park' {
  // A non-idempotent adapter is normally parked: the previous owner may have dispatched the call before it stopped,
  // and running it again could duplicate the effect. An adapter that recorded its own stages and declares itself
  // resumable is the exception — it can continue from where the record says it stopped, without repeating a write
  // the record shows was completed (CAL-01).
  return reclaimed && !idempotent && !resumable ? 'park' : 'run';
}

/** The outcomes that map to a terminal journal status. `retryable` is scheduled instead. */
type TerminalOutcome<T> = Exclude<ProviderAdapterOutcome<T>, { status: 'retryable' }>;

/** Map an adapter outcome to the journal's terminal status. */
export function journalStatusFor(outcome: TerminalOutcome<unknown>): Extract<ProviderOperationStatus, 'committed' | 'accepted_pending' | 'conflict' | 'failed' | 'outcome_unknown'> {
  switch (outcome.status) {
    case 'committed': return 'committed';
    case 'accepted_pending': return 'accepted_pending';
    case 'conflict': return 'conflict';
    case 'permanent': return 'failed';
    case 'outcome_unknown': return 'outcome_unknown';
  }
}

/**
 * Run one provider mutation under the journal.
 *
 * The payload is passed to the adapter rather than the adapter being closed over
 * it, so an adapter stays a plain value that tests can drive without a route.
 */
export async function runProviderMutation<TPayload, TResult = unknown>(
  request: ProviderMutationRequest<TPayload>,
  adapter: ProviderMutationAdapter<TPayload, TResult>,
): Promise<ProviderMutationResult<TResult>> {
  // ── Phase 1: durable claim, committed before the provider is touched ──────
  const claim = await withTransaction(client => beginOperation(client, {
    userId: request.userId,
    accountId: request.accountId ?? null,
    connectionId: request.connectionId ?? null,
    collectionId: request.collectionId ?? null,
    resourceType: adapter.resourceType,
    operation: request.operation,
    resourceId: request.resourceId ?? null,
    idempotencyKey: request.idempotencyKey ?? null,
    payloadHash: request.payloadHash ?? null,
    // Stored so a scheduled retry can be handed back to an adapter later; the
    // pending pool is unreadable without it.
    payload: request.payload,
    expectedVersions: request.expectedVersions,
    leaseSeconds: request.leaseSeconds,
    owner: request.owner ?? null,
  }));

  if (claim.outcome === 'conflict') {
    return { status: 'conflict', operationId: null, code: 'IDEMPOTENCY_KEY_REUSED', replayed: false };
  }
  if (claim.outcome === 'duplicate') {
    // An identical intent that already finished (or that is parked) is answered
    // from the journal; the provider is not called again.
    return {
      status: REPLAY_STATUS[claim.status],
      operationId: claim.operationId,
      value: claim.result as TResult | undefined,
      code: claim.errorCode ?? (claim.status === 'outcome_unknown' ? 'MUTATION_OUTCOME_UNKNOWN' : undefined),
      replayed: true,
    };
  }
  if (claim.outcome === 'in_progress') {
    return { status: 'pending', operationId: claim.operationId, replayed: true,
      ...(claim.retryAfterSeconds !== undefined ? { retryAfterSeconds: claim.retryAfterSeconds } : {}),
    };
  }

  // ── Phase 2: the provider call, with the claim already durable ────────────
  const resumable = Boolean(adapter.resumeFrom?.(claim.progress ?? []));
  if (reclaimDecision(claim.reclaimed, adapter.idempotent, resumable) === 'park') {
    await withTransaction(client => completeOperation(client, {
      operationId: claim.operationId,
      claimToken: claim.claimToken,
      generation: claim.generation,
      status: 'outcome_unknown',
      errorCode: 'MUTATION_OUTCOME_UNKNOWN',
    }));
    return {
      status: 'outcome_unknown',
      operationId: claim.operationId,
      code: 'MUTATION_OUTCOME_UNKNOWN',
      replayed: true,
      ...(claim.progress?.length ? { progress: claim.progress } : {}),
    };
  }

  const controller = new AbortController();
  const timer = request.timeoutMs === undefined ? null : setTimeout(() => controller.abort(), request.timeoutMs);
  let outcome: ProviderAdapterOutcome<TResult>;
  try {
    outcome = await adapter.perform(request.payload, {
      operationId: claim.operationId,
      signal: controller.signal,
      progress: claim.progress ?? [],
      // Durable, so a run that dies after the first write leaves evidence rather than a bare "in flight".
      recordProgress: async (stage: string, detail?: unknown) => {
        await withTransaction(client => recordOperationProgress(client, {
          operationId: claim.operationId,
          claimToken: claim.claimToken,
          generation: claim.generation,
          stage,
          detail,
        })).catch(error => console.warn(
          `Could not record stage ${stage} of operation ${claim.operationId}:`,
          error instanceof Error ? error.message : error,
        ));
      },
    });
  } catch (error) {
    // The adapter did not classify this. It may have reached the provider, so the
    // only safe reading is "unknown" — never an automatic retry.
    outcome = { status: 'outcome_unknown', code: codeFrom(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }

  // ── Phase 3: record the terminal state under the same claim ───────────────
  if (outcome.status === 'retryable') {
    // A retryable outcome asserts nothing was applied, so the operation is safe to
    // run again — but only under a new claim, never inside this one.
    const backoff = (value: number | undefined): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.ceil(value) : 0;
    const delaySeconds = Math.max(backoff(request.retry?.delaySeconds), backoff(outcome.retryAfterSeconds));
    const scheduled = await withTransaction(client => scheduleOperationRetry(client, {
      operationId: claim.operationId,
      claimToken: claim.claimToken,
      generation: claim.generation,
      errorCode: outcome.code ?? null,
      nextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
    }));
    if (!scheduled) return { status: 'outcome_unknown', operationId: claim.operationId, code: 'MUTATION_OUTCOME_UNKNOWN', replayed: false };
    return { status: 'retryable', operationId: claim.operationId, code: outcome.code, retryAfterSeconds: delaySeconds, replayed: false };
  }

  const status = journalStatusFor(outcome);
  const errorCode = 'code' in outcome ? outcome.code ?? null : null;

  const recorded = await withTransaction(client => completeOperation(client, {
    operationId: claim.operationId,
    claimToken: claim.claimToken,
    generation: claim.generation,
    status,
    result: 'value' in outcome ? outcome.value : undefined,
    errorCode,
  }));
  if (!recorded) {
    // The lease expired or the generation was superseded while the provider call
    // was in flight. This worker's result is no longer authoritative, and saying
    // "confirmed" from here would be exactly the false claim the fencing exists
    // to prevent.
    return { status: 'outcome_unknown', operationId: claim.operationId, code: 'MUTATION_OUTCOME_UNKNOWN', replayed: false };
  }

  switch (outcome.status) {
    case 'committed':
      return { status: 'confirmed', operationId: claim.operationId, value: outcome.value, replayed: false };
    case 'accepted_pending':
      return { status: 'accepted', operationId: claim.operationId, value: outcome.value, replayed: false };
    case 'conflict':
      return { status: 'conflict', operationId: claim.operationId, code: errorCode ?? undefined, value: outcome.value, replayed: false };
    case 'permanent':
      return { status: 'permanent', operationId: claim.operationId, code: outcome.code, replayed: false };
    case 'outcome_unknown':
      return { status: 'outcome_unknown', operationId: claim.operationId, code: errorCode ?? undefined, replayed: false };
  }
}
