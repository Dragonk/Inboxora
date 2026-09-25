import { createHash } from 'node:crypto';
import { googleConfigFromEnv, microsoftConfigFromEnv } from './providerAuthService.js';
import { runProviderMutation, type ProviderAdapterOutcome, type ProviderMutationAdapter, type ProviderMutationResult } from './providerMutationService.js';
import { GoogleApiError, type GoogleApiOptions } from './providers/google/googleApiClient.js';
import { GraphApiError, type GraphApiOptions } from './providers/microsoft/graphApiClient.js';
import { createGoogleManagedCalendar, deleteGoogleManagedCalendar, GoogleCalendarProtectionError } from './providers/google/googleCalendarManagement.js';
import { createGraphManagedCalendar, deleteGraphManagedCalendar, GraphCalendarProtectionError } from './providers/microsoft/graphCalendarManagement.js';

export type CalendarCollectionProvider = 'google' | 'microsoft';
interface MutationIdentity {
  /** Server-resolved identities, never copied from an untrusted connection selector. */
  userId: string;
  accountId: string;
  connectionId: string;
  idempotencyKey: string;
}
type DeleteIntent = { action: 'delete'; remoteCalendarId: string; collectionId: string; localCalendarId: string };
export type CalendarCollectionMutationInput = MutationIdentity & (
  | { provider: CalendarCollectionProvider; action: 'create'; name: string }
  | (DeleteIntent & { provider: 'google' })
  | (DeleteIntent & { provider: 'microsoft'; verifiedMailboxIdentity: string })
);

/** Fixed field order and explicit nulls form the versioned, secret-free journal contract. */
export interface CalendarCollectionMutationPayload {
  version: 1;
  provider: CalendarCollectionProvider;
  action: 'create' | 'delete';
  accountId: string;
  connectionId: string;
  collectionId: string | null;
  localCalendarId: string | null;
  remoteCalendarId: string | null;
  name: string | null;
  verifiedMailboxIdentity: string | null;
}
export interface CalendarCollectionMutationValue {
  provider: CalendarCollectionProvider;
  action: 'create' | 'delete';
  remoteCalendarId: string;
  name: string | null;
}
export interface CalendarCollectionMutationOptions {
  googleApi?: Omit<Partial<GoogleApiOptions>, 'userId' | 'connectionId' | 'signal'>;
  graphApi?: Omit<Partial<GraphApiOptions>, 'userId' | 'connectionId' | 'signal'>;
  /** Test seams only; production uses the guarded native helpers. */
  calls?: Partial<{
    createGoogle: typeof createGoogleManagedCalendar;
    deleteGoogle: typeof deleteGoogleManagedCalendar;
    createGraph: typeof createGraphManagedCalendar;
    deleteGraph: typeof deleteGraphManagedCalendar;
  }>;
}
export class CalendarCollectionMutationValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(readonly field: string) {
    super(`Invalid calendar collection mutation field: ${field}`);
    this.name = 'CalendarCollectionMutationValidationError';
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function identity(value: unknown, field: string): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new CalendarCollectionMutationValidationError(field);
  return value.toLowerCase();
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length > max || !value.trim() || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new CalendarCollectionMutationValidationError(field);
  return value;
}
function remoteId(value: unknown): string {
  const id = text(value, 'remoteCalendarId', 2048);
  if (id !== id.trim() || id === '.' || id === '..') throw new CalendarCollectionMutationValidationError('remoteCalendarId');
  return id;
}

export function buildCalendarCollectionMutationIntent(input: CalendarCollectionMutationInput): {
  userId: string; idempotencyKey: string; payload: CalendarCollectionMutationPayload; payloadHash: string;
} {
  const userId = identity(input.userId, 'userId');
  const accountId = identity(input.accountId, 'accountId');
  const connectionId = identity(input.connectionId, 'connectionId');
  const key = text(input.idempotencyKey, 'idempotencyKey', 200);
  if (key !== key.trim()) throw new CalendarCollectionMutationValidationError('idempotencyKey');
  if (input.provider !== 'google' && input.provider !== 'microsoft') throw new CalendarCollectionMutationValidationError('provider');
  if (input.action !== 'create' && input.action !== 'delete') throw new CalendarCollectionMutationValidationError('action');
  let verifiedMailboxIdentity: string | null = null;
  if (input.action === 'delete' && input.provider === 'microsoft') {
    verifiedMailboxIdentity = text(input.verifiedMailboxIdentity, 'verifiedMailboxIdentity', 320).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(verifiedMailboxIdentity)) throw new CalendarCollectionMutationValidationError('verifiedMailboxIdentity');
  }
  const payload: CalendarCollectionMutationPayload = {
    version: 1,
    provider: input.provider,
    action: input.action,
    accountId,
    connectionId,
    collectionId: input.action === 'delete' ? identity(input.collectionId, 'collectionId') : null,
    localCalendarId: input.action === 'delete' ? identity(input.localCalendarId, 'localCalendarId') : null,
    remoteCalendarId: input.action === 'delete' ? remoteId(input.remoteCalendarId) : null,
    name: input.action === 'create' ? text(input.name, 'name', 255).trim() : null,
    verifiedMailboxIdentity,
  };
  return { userId, idempotencyKey: key, payload, payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
}

/** Never equate the generic provider `retryable` flag (which includes 5xx) with a safe write retry. */
export function classifyCalendarCollectionMutationError(error: unknown): ProviderAdapterOutcome<CalendarCollectionMutationValue> {
  if (error instanceof GoogleCalendarProtectionError || error instanceof GraphCalendarProtectionError) {
    return { status: 'permanent', code: `CALENDAR_PROTECTED_${error.reason.toUpperCase()}` };
  }
  if (error instanceof GoogleApiError || error instanceof GraphApiError) {
    if (error.status === 429) return { status: 'retryable', code: error.code, retryAfterSeconds: error.retryAfterSeconds };
    // A request timeout is not proof that an already-dispatched mutation did not commit.
    if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 499) return { status: 'permanent', code: error.code };
    return { status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' };
  }
  return { status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' };
}

export function calendarCollectionMutationAdapter(userId: string, options: CalendarCollectionMutationOptions = {}): ProviderMutationAdapter<CalendarCollectionMutationPayload, CalendarCollectionMutationValue> {
  return {
    resourceType: 'calendar_collection',
    // Even delete requires fresh ownership guards; a reclaimed unknown write is parked, not repeated.
    idempotent: false,
    async perform(payload, context) {
      try {
        context.signal.throwIfAborted();
        let id: string;
        let name: string | null = null;
        if (payload.provider === 'google') {
          const api: GoogleApiOptions = { ...options.googleApi, userId, connectionId: payload.connectionId, config: options.googleApi?.config ?? googleConfigFromEnv(), signal: context.signal };
          if (payload.action === 'create') {
            const created = await (options.calls?.createGoogle ?? createGoogleManagedCalendar)(api, payload.name!);
            id = remoteId(created.id); name = created.summary;
          } else {
            id = remoteId(payload.remoteCalendarId);
            await (options.calls?.deleteGoogle ?? deleteGoogleManagedCalendar)(api, id);
          }
        } else {
          const api: GraphApiOptions = { ...options.graphApi, userId, connectionId: payload.connectionId, config: options.graphApi?.config ?? microsoftConfigFromEnv(), signal: context.signal };
          if (payload.action === 'create') {
            const created = await (options.calls?.createGraph ?? createGraphManagedCalendar)(api, payload.name!);
            id = remoteId(created.id); name = created.name;
          } else {
            id = remoteId(payload.remoteCalendarId);
            await (options.calls?.deleteGraph ?? deleteGraphManagedCalendar)(api, id, payload.verifiedMailboxIdentity!);
          }
        }
        context.signal.throwIfAborted();
        return { status: 'committed', value: { provider: payload.provider, action: payload.action, remoteCalendarId: id, name: typeof name === 'string' ? name : null } };
      } catch (error) {
        return classifyCalendarCollectionMutationError(error);
      }
    },
  };
}

/** Authorize ownership/capability before this call; project local state only after its confirmed result. */
export async function runCalendarCollectionMutation(input: CalendarCollectionMutationInput, options: CalendarCollectionMutationOptions = {}): Promise<ProviderMutationResult<CalendarCollectionMutationValue>> {
  const intent = buildCalendarCollectionMutationIntent(input);
  return runProviderMutation({
    userId: intent.userId, accountId: intent.payload.accountId, connectionId: intent.payload.connectionId,
    collectionId: intent.payload.collectionId, resourceId: intent.payload.localCalendarId,
    channel: 'web', operation: intent.payload.action,
    idempotencyKey: intent.idempotencyKey, payloadHash: intent.payloadHash, payload: intent.payload,
    timeoutMs: 20_000,
  }, calendarCollectionMutationAdapter(intent.userId, options));
}
