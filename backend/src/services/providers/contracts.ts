/**
 * Shared provider-layer contracts (v4 plan, sections 4 and 7).
 *
 * These types are the stable vocabulary the mail, calendar and contact command
 * services use regardless of the protocol behind them. They are deliberately
 * free of Express, database or adapter imports so they can be consumed by
 * routes, workers, the DAV server and plugins without creating a cycle.
 *
 * The plan's working names are kept where they are already unambiguous; a few
 * are prefixed (`ProviderOperation`, `MailboxPolicy`) to avoid colliding with
 * existing exports in the codebase. `Operation` is re-exported as an alias for
 * the plan's spelling.
 */

/** The single authoritative mail transport of an account. */
export type MailTransport = 'imap_smtp' | 'microsoft_graph' | 'gmail_api';

/** Origin of a collection/resource the user can read or write. */
export type SourceKind = 'local' | 'microsoft' | 'google' | 'caldav' | 'carddav' | 'ical_url';

/** Independent feature switches on an account. */
export type IntegrationFeature = 'mail' | 'calendars' | 'contacts';

/** Whether the user chose "follow the source" or forced read-only locally. */
export type AccessMode = 'source' | 'read_only';

/** How a collection of Inboxora data is shared over DAV. */
export type DavMode = 'off' | 'read_only' | 'read_write';

/**
 * Conflict protection actually offered by a provider for one operation.
 * `atomic` means the endpoint honours a version precondition; `best_effort`
 * means a compare-then-write with a residual race; `unsupported` means there
 * is no precondition at all.
 */
export type ConflictProtection = 'atomic' | 'best_effort' | 'unsupported';

export type ProviderOperation = 'read' | 'create' | 'update' | 'delete' | 'rsvp' | 'send';

/** Alias matching the plan's wording. */
export type Operation = ProviderOperation;

/** Provider migration policy. Microsoft is `required` for supported mailboxes. */
export type MailboxPolicy = 'required' | 'recommended' | 'none';

export interface ActorContext {
  userId: string;
  accountId?: string;
  /** Only set for DAV app-password authentication. */
  credentialId?: string;
  channel: 'web' | 'dav' | 'worker' | 'plugin';
  operationId: string;
}

export interface OperationCapability {
  allowed: boolean;
  reasonCode?: string;
  conflictProtection: ConflictProtection;
  limits?: Readonly<Record<string, number>>;
}

export type OperationCapabilityMap = Readonly<Record<ProviderOperation, OperationCapability>>;

export interface CollectionCapabilities {
  revision: string;
  checkedAt: string;
  readDetails: 'full' | 'busy_only' | 'none';
  operations: OperationCapabilityMap;
  editableFields: readonly string[];
}

/**
 * Opaque remote identity of one object. `objectRemoteId` is never parsed as a
 * number: IMAP UIDs, Gmail ids and DAV hrefs have different semantics.
 */
export interface RemoteRef {
  connectionId: string;
  collectionRemoteId: string;
  objectRemoteId: string;
  remoteVersion?: string;
}

export interface SyncPage<T> {
  records: readonly T[];
  deletions: readonly RemoteRef[];
  nextPage?: string;
  completedCursor?: string;
  completeness: 'page' | 'complete_snapshot' | 'delta';
}

export interface MutationContext {
  actor: ActorContext;
  operationId: string;
  expectedLocalRevision: string;
  expectedRemoteVersion?: string;
  generation: string;
  signal: AbortSignal;
}

/**
 * Result of an external mutation. `accepted_pending` is not delivery, and
 * `outcome_unknown` must never be retried automatically.
 */
export type MutationOutcome = 'committed' | 'accepted_pending' | 'conflict' | 'outcome_unknown';

export interface MutationResult<T = unknown> {
  outcome: MutationOutcome;
  /** Canonical representation after the mutation, when the provider returned one. */
  value?: T;
  /** New remote identity/version to persist. */
  remote?: RemoteRef;
  problem?: ApiProblem;
}

/** Closed set in the implementation; unknown codes still map to a safe fallback. */
export type ApiProblemCode =
  | 'VALIDATION_ERROR'
  | 'SESSION_REQUIRED'
  | 'PROVIDER_AUTH_REQUIRED'
  | 'ADMIN_CONFIGURATION_REQUIRED'
  | 'ADMIN_CONSENT_REQUIRED'
  | 'INSUFFICIENT_SCOPES'
  | 'COLLECTION_READ_ONLY'
  | 'OPERATION_FORBIDDEN'
  | 'RESOURCE_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'ATTACHMENT_TOO_LARGE'
  | 'MESSAGE_TOO_LARGE'
  | 'ATTACHMENT_TYPE_BLOCKED'
  | 'ATTACHMENT_FETCH_FAILED'
  | 'UPLOAD_SESSION_EXPIRED'
  | 'MAILBOX_QUOTA_EXCEEDED'
  | 'SEND_LIMIT_REACHED'
  | 'RATE_LIMITED'
  /**
   * Another worker already holds the synchronization lease for this collection. Distinct from `RATE_LIMITED`
   * on purpose: it is this application's own concurrency guard, not the provider throttling us, so a scheduler
   * must skip this collection without backing off the whole installation (SYNC-08).
   */
  | 'SYNC_ALREADY_RUNNING'
  | 'UPSTREAM_UNAVAILABLE'
  | 'SEND_OUTCOME_UNKNOWN'
  | 'MUTATION_OUTCOME_UNKNOWN'
  | 'UNSUPPORTED_CONVERSION'
  | 'INVALID_SYNC_CURSOR'
  | 'PARTIAL_SYNC'
  | 'ACCOUNT_MIGRATION_REQUIRED'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'STORAGE_UNAVAILABLE'
  | 'INVALID_DAV_RESPONSE'
  | 'INVALID_ICS'
  | 'INVALID_VCARD'
  // The mailbox may not send as the identity the user chose. This is not a missing scope: reconnecting the
  // account changes nothing, and reporting it as one sent the user to re-authorize an account that was already
  // authorized, while the alias silently travelled as the primary address.
  | 'SEND_AS_DENIED'
  | 'INTERNAL_ERROR';

export type ApiProblemAction =
  | 'reauthorize'
  | 'migrate'
  | 'contact_admin'
  | 'resolve_conflict'
  | 'remove_attachment'
  | 'check_send_status';

export interface ApiProblemDetails {
  fileName?: string;
  actualBytes?: number;
  limitBytes?: number;
  limitKind?: 'file' | 'attachments' | 'mime' | 'http_body' | 'storage';
  failedItemIds?: readonly string[];
}

/**
 * Safe, serialisable error contract. It never carries provider URLs, tokens or
 * message bodies — only a closed code, a translation key and bounded details.
 */
export interface ApiProblem {
  code: ApiProblemCode;
  messageKey: string;
  correlationId: string;
  accountId?: string;
  collectionId?: string;
  operationId?: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  action?: ApiProblemAction;
  details?: ApiProblemDetails;
}

/** A provider's declared support matrix, used to gate operations before they run. */
export interface ProviderDescriptor {
  /**
   * Resource origin for calendar/contact collections. A pure mail transport
   * (IMAP/SMTP) has no single collection origin, so it omits this.
   */
  readonly source?: SourceKind;
  /** Mail transport this descriptor implements, when it handles mail. */
  readonly mailTransport?: MailTransport;
  readonly features: readonly IntegrationFeature[];
  /**
   * Whether **this build's** adapter forwards a mutation to the collection's
   * origin. False for an import/read-only source and for an adapter whose write
   * path is not implemented yet: the capability resolver trusts this field, so
   * it must not advertise a write the adapter cannot perform.
   */
  readonly writeThrough: boolean;
  /** Per-operation conflict protection offered by the provider endpoints. */
  readonly conflictProtection: Readonly<Record<ProviderOperation, ConflictProtection>>;
}
export const PROVIDER_OPERATIONS: readonly ProviderOperation[] = Object.freeze([
  'read', 'create', 'update', 'delete', 'rsvp', 'send',
]);

export function isMailTransport(value: unknown): value is MailTransport {
  return value === 'imap_smtp' || value === 'microsoft_graph' || value === 'gmail_api';
}

export function isSourceKind(value: unknown): value is SourceKind {
  return value === 'local' || value === 'microsoft' || value === 'google'
    || value === 'caldav' || value === 'carddav' || value === 'ical_url';
}

export function isIntegrationFeature(value: unknown): value is IntegrationFeature {
  return value === 'mail' || value === 'calendars' || value === 'contacts';
}

export function isDavMode(value: unknown): value is DavMode {
  return value === 'off' || value === 'read_only' || value === 'read_write';
}

export function isAccessMode(value: unknown): value is AccessMode {
  return value === 'source' || value === 'read_only';
}

/**
 * Normalise an untrusted DB/HTTP value. A missing or unrecognised transport is
 * treated as the legacy IMAP/SMTP transport: that is the only way a pre-v4 row
 * could have worked, and the plan forbids inventing a native transport.
 */
export function normalizeMailTransport(value: unknown): MailTransport {
  return isMailTransport(value) ? value : 'imap_smtp';
}
