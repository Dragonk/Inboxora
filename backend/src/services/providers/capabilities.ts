import { PROVIDER_OPERATIONS } from './contracts.js';
import type {
  CollectionCapabilities,
  ConflictProtection,
  OperationCapability,
  OperationCapabilityMap,
  ProviderOperation,
} from './contracts.js';

/**
 * One input to the effective-permission decision (v4 plan §7.1). Every layer —
 * Inboxora ownership, the enabled integration and selected collection, the
 * scopes actually granted, the source collection rights, the object/role, the
 * adapter's support, the user's local limit and the channel/password limit — is
 * an independent factor. The operation is allowed only when all of them allow
 * it.
 */
export interface PermissionFactor {
  allowed: boolean;
  /** Stable code surfaced to the client, e.g. `OPERATION_FORBIDDEN`. */
  reasonCode?: string;
}

export function allow(): PermissionFactor {
  return { allowed: true };
}

export function deny(reasonCode: string): PermissionFactor {
  return { allowed: false, reasonCode };
}

/**
 * Intersect permission factors. The first denial (in call order) supplies the
 * reason; a missing capability is never treated as proof of write access.
 */
export function combinePermissions(
  factors: readonly PermissionFactor[],
  conflictProtection: ConflictProtection,
  limits?: Readonly<Record<string, number>>,
): OperationCapability {
  const denied = factors.find(factor => !factor.allowed);
  const capability: OperationCapability = denied
    ? { allowed: false, reasonCode: denied.reasonCode ?? 'OPERATION_FORBIDDEN', conflictProtection }
    : { allowed: true, conflictProtection };
  return limits ? { ...capability, limits } : capability;
}

export function capabilityMap(
  build: (operation: ProviderOperation) => OperationCapability,
): OperationCapabilityMap {
  const entries = PROVIDER_OPERATIONS.map(operation => [operation, build(operation)] as const);
  return Object.freeze(Object.fromEntries(entries)) as OperationCapabilityMap;
}

/** Every operation is denied with the same code (e.g. a revoked grant). */
export function deniedCapabilities(reasonCode: string, conflictProtection: ConflictProtection = 'unsupported'): OperationCapabilityMap {
  return capabilityMap(() => ({ allowed: false, reasonCode, conflictProtection }));
}

/** Read is allowed; mutations are denied. Used for RO collections and channels. */
export function readOnlyCapabilities(options: {
  reasonCode: string;
  conflictProtection?: ConflictProtection;
  readDetails?: CollectionCapabilities['readDetails'];
  revision?: string;
  checkedAt?: string;
  editableFields?: readonly string[];
}): CollectionCapabilities {
  const conflictProtection = options.conflictProtection ?? 'unsupported';
  return {
    revision: options.revision ?? '0',
    checkedAt: options.checkedAt ?? new Date(0).toISOString(),
    readDetails: options.readDetails ?? 'full',
    operations: capabilityMap(operation => operation === 'read'
      ? { allowed: true, conflictProtection }
      : { allowed: false, reasonCode: options.reasonCode, conflictProtection }),
    editableFields: options.editableFields ?? [],
  };
}

/**
 * A collection whose operations are all allowed according to the adapter's
 * declared conflict protection. `send`/`rsvp` are separate capabilities and
 * callers that do not support them must deny them explicitly.
 */
export function sourceCapabilities(options: {
  conflictProtection: Readonly<Record<ProviderOperation, ConflictProtection>>;
  revision?: string;
  checkedAt?: string;
  readDetails?: CollectionCapabilities['readDetails'];
  editableFields?: readonly string[];
  deny?: Partial<Record<ProviderOperation, string>>;
}): CollectionCapabilities {
  return {
    revision: options.revision ?? '0',
    checkedAt: options.checkedAt ?? new Date(0).toISOString(),
    readDetails: options.readDetails ?? 'full',
    operations: capabilityMap(operation => {
      const denyReason = options.deny?.[operation];
      if (denyReason) {
        return { allowed: false, reasonCode: denyReason, conflictProtection: options.conflictProtection[operation] };
      }
      return { allowed: true, conflictProtection: options.conflictProtection[operation] };
    }),
    editableFields: options.editableFields ?? [],
  };
}

/**
 * A collection only exposes DAV when its effective mode is not `off`. A device
 * password may narrow access further, never widen it.
 */
export function effectiveDavMode(
  collectionMode: 'off' | 'read_only' | 'read_write',
  credentialMaxMode: 'read_only' | 'read_write' | null,
  writable: boolean,
): 'off' | 'read_only' | 'read_write' {
  if (collectionMode === 'off') return 'off';
  if (!writable) return collectionMode === 'read_write' ? 'read_only' : collectionMode;
  if (credentialMaxMode === 'read_only') return 'read_only';
  return collectionMode;
}
