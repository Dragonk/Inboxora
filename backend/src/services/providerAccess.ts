import { deny, capabilityMap, combinePermissions, effectiveDavMode } from './providers/capabilities.js';
import type { PermissionFactor } from './providers/capabilities.js';
import { createDefaultRegistry } from './providers/registry.js';
import type { ProviderKey, ProviderRegistry } from './providers/registry.js';
import { isSourceKind } from './providers/contracts.js';
import type {
  CollectionCapabilities,
  ConflictProtection,
  DavMode,
  IntegrationFeature,
  OperationCapability,
  ProviderOperation,
  SourceKind,
} from './providers/contracts.js';

/**
 * The single decision point for "may this operation run against this
 * collection?" (v4 plan §7.1).
 *
 * Before this module the rule was written out at every call site — REST and DAV
 * each compared `source` against `'local'`, checked the collection's own
 * read-only flag and the device password separately — so the advertised
 * privileges and the enforced guard could drift, and adding an adapter meant
 * editing every one of them. The scattered comparisons are still the *inputs*,
 * but they are now combined in one place from the provider registry's declared
 * capabilities, so an adapter implements a capability by declaring it and every
 * caller sees the change.
 *
 * The layers, in the order they are applied (the first denial supplies the
 * reason, which is what the client is told):
 *
 *  1. the origin's adapter exists and serves this feature (`registry.forSource`);
 *  2. that adapter forwards mutations to the origin (`writeThrough`, or the
 *     origin *is* Inboxora and the source is `local`);
 *  3. the operation has a conflict protection other than `unsupported`;
 *  4. the collection's own access mode is not read-only;
 *  5. on the DAV channel, the effective mode after the device password's ceiling
 *     is `read_write` — a password and a DAV mode can only narrow, never widen.
 */

export interface CollectionAccessRow {
  /** `calendars.source` / `address_books.source`; absent means the DB default, `local`. */
  source?: string | null;
  /** `calendars.read_only`; `address_books` has no such column. */
  read_only?: boolean | null;
  dav_mode?: string | null;
  /**
   * `integration_collections.source_access`: what the **origin itself** permits. `read_only` means the
   * provider would refuse or silently ignore a write, so no user setting can make it writable.
   */
  source_access?: string | null;
  /**
   * `integration_collections.user_access`: the user's choice for this collection. Only `read_write`
   * enables write-back, and it is never a default — a freshly pulled collection is read-only until the
   * user asks otherwise, which is what keeps "a read-only collection stays read-only once writes exist"
   * true even after an adapter learns to write.
   */
  user_access?: string | null;
}

export interface CollectionAccessRequest {
  feature: IntegrationFeature;
  operation: ProviderOperation;
  /** `web` is the REST/plugin path; `dav` additionally applies the DAV rules. */
  channel?: 'web' | 'dav';
  /** The authenticating device password's ceiling; only meaningful on `dav`. */
  credentialMaxMode?: 'read_only' | 'read_write' | null;
}

export interface CollectionAccess {
  allowed: boolean;
  /** Domain code for a refusal; absent when the operation is allowed. */
  reasonCode?: string;
  conflictProtection: ConflictProtection;
  /** The collection's DAV mode after the credential ceiling and source rights. */
  effectiveDavMode: DavMode;
  /** The adapter that owns this collection, or `null` when none claims it. */
  providerKey: ProviderKey | null;
  /**
   * The full per-operation picture. The mutation layer and the interfaces read
   * this rather than re-deriving writability from `source` themselves.
   */
  capabilities: CollectionCapabilities;
}

export interface CollectionAccessOptions {
  /** Injected in tests; the application always uses the default registry. */
  registry?: ProviderRegistry;
}

const defaultRegistry = createDefaultRegistry();

/**
 * An unknown string origin is not silently upgraded to `local` — it has no
 * adapter, so every mutation is refused. Only a genuinely absent value is the
 * pre-v4 DB default (`local`, which is what the column defaults to).
 */
function originOf(row: CollectionAccessRow): SourceKind | null {
  const value = row.source;
  if (value === null || value === undefined || value === '') return 'local';
  return isSourceKind(value) ? value : null;
}

/** An unknown/absent mode is treated as fully enabled, matching pre-0105 rows. */
export function normalizeDavMode(value: unknown): DavMode {
  return value === 'off' || value === 'read_only' || value === 'read_write' ? value : 'read_write';
}

export function resolveCollectionAccess(
  row: CollectionAccessRow,
  request: CollectionAccessRequest,
  options: CollectionAccessOptions = {},
): CollectionAccess {
  const registry = options.registry ?? defaultRegistry;
  const channel = request.channel ?? 'web';
  const credentialMaxMode = request.credentialMaxMode ?? null;
  const origin = originOf(row);
  const registration = origin === null ? undefined : registry.forSource(origin, request.feature);
  const collectionDavMode = normalizeDavMode(row.dav_mode);

  // Layer 2: `local` is the origin itself; every other origin needs an adapter that actually writes
  // through.
  const forwardsMutations = registration !== undefined
    && (registration.source === 'local' || registration.writeThrough);
  /**
   * Whether a **DAV** write can actually be forwarded.
   *
   * The DAV channel is served by `routes/caldav.ts` and `routes/carddav.ts`, which forward a `PUT`/`DELETE`
   * to the external CalDAV/CardDAV source (and accept one for the local store). A provider collection —
   * Microsoft Graph, Google — is written by the REST routes, not by those handlers, so a DAV write to it
   * would be applied to the local copy and discarded by the next sync: precisely the outcome the refusal
   * exists to prevent. Advertising it as DAV-writable is the same mistake as accepting it, so the DAV
   * ceiling is computed from what the DAV handlers genuinely forward, not from the web write-through flag.
   */
  const forwardsDavMutations = forwardsMutations
    && registration !== undefined
    && (registration.source === 'local' || registration.key === 'caldav' || registration.key === 'carddav');
  const effective = effectiveDavMode(collectionDavMode, credentialMaxMode, forwardsDavMutations);

  const conflictProtectionFor = (operation: ProviderOperation): ConflictProtection =>
    registration?.conflictProtection[operation] ?? 'unsupported';

  const operations = capabilityMap(operation => {
    const conflictProtection = conflictProtectionFor(operation);
    if (operation === 'read') {
      // Reading is what every registered adapter does; an unclaimed origin has
      // no reader either, and is refused rather than assumed readable.
      return registration
        ? { allowed: true, conflictProtection }
        : { allowed: false, reasonCode: 'OPERATION_FORBIDDEN', conflictProtection };
    }
    const factors: PermissionFactor[] = [];
    if (!registration) {
      factors.push(deny('OPERATION_FORBIDDEN'));
    } else {
      if (!forwardsMutations) factors.push(deny('OPERATION_FORBIDDEN'));
      if (conflictProtection === 'unsupported') factors.push(deny('OPERATION_FORBIDDEN'));
    }
    if (row.read_only === true) factors.push(deny('COLLECTION_READ_ONLY'));
    // The origin's own permission and the user's choice are separate gates, and both must permit the
    // write. A collection whose origin is read-only can never be written, whatever the user selects; a
    // collection the user has not enabled stays read-only even though its adapter can now write it.
    // They apply only to a **remote** collection: `local` is Inboxora's own store, has no
    // `integration_collections` row, and must not be denied because those columns are absent.
    if (origin !== null && origin !== 'local') {
      if (row.source_access === 'read_only') factors.push(deny('COLLECTION_READ_ONLY'));
      if (row.user_access !== 'read_write') factors.push(deny('COLLECTION_READ_ONLY'));
    }
    if (channel === 'dav' && effective !== 'read_write') factors.push(deny('COLLECTION_READ_ONLY'));
    return combinePermissions(factors, conflictProtection);
  });

  const requested: OperationCapability = operations[request.operation];
  return {
    allowed: requested.allowed,
    reasonCode: requested.allowed ? undefined : (requested.reasonCode ?? 'OPERATION_FORBIDDEN'),
    conflictProtection: requested.conflictProtection,
    effectiveDavMode: effective,
    providerKey: registration?.key ?? null,
    capabilities: {
      // A real revision is what the mutation layer will compare against; until
      // then these are the placeholders `capabilities.ts` uses for a decision
      // that was computed rather than read from a stored row.
      revision: '0',
      checkedAt: new Date(0).toISOString(),
      readDetails: 'full',
      operations,
      editableFields: [],
    },
  };
}

/** Whether the collection accepts an ordinary (non-DAV) mutation. */
export function collectionIsWritable(row: CollectionAccessRow, feature: IntegrationFeature): boolean {
  return resolveCollectionAccess(row, { feature, operation: 'update' }).allowed;
}

/** Whether the collection accepts a mutation over the DAV channel. */
export function collectionDavWritable(
  row: CollectionAccessRow,
  feature: IntegrationFeature,
  credentialMaxMode: 'read_only' | 'read_write' | null,
): boolean {
  return resolveCollectionAccess(row, { feature, operation: 'update', channel: 'dav', credentialMaxMode }).allowed;
}

/**
 * The reason code for a refused DAV write, mapped to the sentence the client is
 * shown. Keeping the mapping here means the DAV routers no longer decide it from
 * `source` themselves.
 */
export function davWriteRefusalMessage(access: CollectionAccess, kind: 'calendar' | 'address book'): string {
  if (access.reasonCode === 'COLLECTION_READ_ONLY') {
    return `This ${kind} is read-only.`;
  }
  return `This ${kind} is written by its source, so Inboxora will not accept changes to it.`;
}
