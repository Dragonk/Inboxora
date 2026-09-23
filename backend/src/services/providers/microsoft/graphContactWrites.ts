import { GraphApiError, type GraphApiOptions } from './graphApiClient.js';
import { graphGet, graphUrl } from './graphApiClient.js';
import {
  createGraphContact,
  deleteGraphContact,
  patchGraphContact,
  vCardToGraphContact,
  type GraphContact,
  type GraphContactPayload,
} from './graphContacts.js';
import { classifyGraphMutationFailure } from './graphMailMutations.js';
import type { ProviderAdapterOutcome, ProviderMutationAdapter } from '../../providerMutationService.js';
import type { VCardContact } from '../../../utils/vcard.js';
import type { GraphContactsTarget } from './graphContacts.js';

/**
 * Microsoft Graph **contact writes** (P09 contacts CRUD).
 *
 * The write path goes through the shared mutation layer, so the durable claim is committed before Graph
 * is touched and an ambiguous answer is parked rather than retried. The three operations are not equally
 * re-runnable, and the adapter says so instead of pretending otherwise:
 *
 *  - a **create** addresses a collection, not a resource, so a second attempt with a recovered claim
 *    would create a second contact — it is not idempotent;
 *  - a **patch** converges on the same end state, so re-applying it is safe;
 *  - a **delete** answers `404` for a contact that is already gone, which cannot be told apart from
 *    "never existed", so it is not treated as re-runnable either.
 *
 * The adapter is declared non-idempotent as a whole because a single `idempotent` flag covers all three
 * operations; that is the conservative direction (a recovered claim is parked), and a create is the
 * operation where a wrong guess is a duplicate the user cannot undo.
 */

/** The local contact fields a write sends. */
export interface GraphContactWritePayload {
  operation: 'create' | 'update' | 'delete';
  /** Typed provider collection target, for a create. */
  target?: GraphContactsTarget;
  /** The provider's contact id, for an update or delete. */
  contactId?: string | null;
  /** The mapped Graph payload for a create or update. */
  payload?: GraphContactPayload;
}

export interface GraphContactWriteResult {
  /** The provider contact a create/update returned, absent for a delete. */
  contact?: GraphContact | null;
}

export function graphContactMutationAdapter(options: {
  api: GraphApiOptions;
  create?: typeof createGraphContact;
  patch?: typeof patchGraphContact;
  remove?: typeof deleteGraphContact;
}): ProviderMutationAdapter<GraphContactWritePayload, GraphContactWriteResult> {
  const create = options.create ?? createGraphContact;
  const patch = options.patch ?? patchGraphContact;
  const remove = options.remove ?? deleteGraphContact;
  return {
    resourceType: 'contact',
    idempotent: false,
    async perform(write): Promise<ProviderAdapterOutcome<GraphContactWriteResult>> {
      try {
        if (write.operation === 'create') {
          if (!write.target) return { status: 'permanent', code: 'RESOURCE_NOT_FOUND' };
          const created = await create(options.api, write.target, write.payload ?? {});
          // A create Graph answers without an id cannot be reconciled against a replay, so it is not
          // reported as a success.
          if (!created?.id) return { status: 'outcome_unknown', code: 'CONTACT_ID_MISSING' };
          return { status: 'committed', value: { contact: created } };
        }
        if (write.operation === 'update') {
          if (!write.contactId) return { status: 'permanent', code: 'RESOURCE_NOT_FOUND' };
          const updated = await patch(options.api, write.contactId, write.payload ?? {});
          return { status: 'committed', value: { contact: updated } };
        }
        if (!write.contactId) return { status: 'permanent', code: 'RESOURCE_NOT_FOUND' };
        await remove(options.api, write.contactId);
        return { status: 'committed' };
      } catch (error) {
        // A patch/delete of a contact that is gone is the end state for a delete, and a fact to report
        // for a patch; both are permanent rather than retryable.
        if (error instanceof GraphApiError && error.code === 'RESOURCE_NOT_FOUND') {
          return { status: 'permanent', code: 'RESOURCE_NOT_FOUND' };
        }
        return classifyGraphMutationFailure(error);
      }
    },
  };
}

/** The provider folder id a local Microsoft address book is linked to. */
export async function graphContactFolderId(api: GraphApiOptions, folderId?: string | null): Promise<string | null> {
  const body = await graphGet<{ id?: string | null }>(
    api,
    graphUrl(`/me/contactFolders/${encodeURIComponent(folderId || 'contacts')}`, { $select: 'id' }),
  );
  return body?.id ?? null;
}

/** The Graph payload for a local contact. `full` distinguishes a create from a patch. */
export function graphContactPayloadFor(contact: VCardContact, operation: 'create' | 'update'): GraphContactPayload {
  return vCardToGraphContact(contact, { full: operation === 'create' });
}
