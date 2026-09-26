import { withTransaction } from '../../db.js';
import { graphFolderIdForPath } from './graphMailSync.js';
import { graphDeleteIntent, graphDeleteMutationAdapter, graphMoveIntent, graphMoveMutationAdapter } from './graphMailMutations.js';
import { projectGraphMove } from './graphMailContinuity.js';
import { runProviderMutation } from '../../providerMutationService.js';
import type { GraphApiOptions } from './graphApiClient.js';
import { immutableIdsEnabled } from './graphMessageIdType.js';

/**
 * Move one Microsoft Graph message to a local folder path and re-home its row.
 *
 * This is the single implementation behind every Graph move — the bulk routes, spam
 * and ham, and the snooze wakeup. It lives here rather than in a route module
 * because the snooze wakeup runs inside the mail manager, and a service importing a
 * route module would be a layering inversion.
 *
 * The part worth naming: a Graph move **re-identifies the message**, so the row
 * adopts the id the provider returned and the compatibility `uid` derived from it.
 * Skipping that would leave the row keyed to an id the provider no longer has, and
 * the next delta would insert a second row for the same message.
 */
export type MoveGraphMessageResult =
  | { moved: true; newProviderMessageId: string; newUid: string }
  | { moved: false; code?: string };

export async function moveGraphMessageToFolder(input: {
  userId: string;
  accountId: string;
  connectionId: string;
  config?: GraphApiOptions['config'];
  immutableIds?: boolean;
  /** The local `messages.id`. */
  resourceId: string;
  providerMessageId: string;
  destinationPath: string;
}): Promise<MoveGraphMessageResult> {
  const immutableIds =
    input.immutableIds ?? await immutableIdsEnabled(input.connectionId);
  const destinationFolderId = await graphFolderIdForPath({
    connectionId: input.connectionId,
    accountId: input.accountId,
    path: input.destinationPath,
  });
  if (!destinationFolderId) return { moved: false, code: 'RESOURCE_NOT_FOUND' };

  const payload = {
    providerMessageId: input.providerMessageId,
    destinationFolderId,
    intentAt: new Date().toISOString(),
  };
  const result = await runProviderMutation(
    {
      userId: input.userId,
      channel: 'web',
      operation: 'update',
      accountId: input.accountId,
      resourceId: input.resourceId,
      ...graphMoveIntent(payload),
      payload,
      retry: { delaySeconds: 300 },
    },
    graphMoveMutationAdapter({
      api: {
        userId: input.userId,
        connectionId: input.connectionId,
        ...(input.config ? { config: input.config } : {}),
        immutableIds,
      },
    }),
  );
  if (result.status !== 'confirmed' || !result.value?.id) {
    return { moved: false, ...(result.code ? { code: result.code } : {}) };
  }

  const targetId = result.value.id;
  const projected = await withTransaction(client => projectGraphMove(client, {
    accountId: input.accountId, connectionId: input.connectionId, rowId: input.resourceId,
    sourceId: input.providerMessageId, targetId, targetPath: input.destinationPath,
  }));
  if (!projected.moved || !projected.uid) {
    return { moved: false, code: 'MUTATION_OUTCOME_UNKNOWN' };
  }
  return { moved: true, newProviderMessageId: targetId, newUid: projected.uid };
}

/**
 * Permanently remove one Microsoft Graph message.
 *
 * The sibling of `moveGraphMessageToFolder` and the same reasoning: one
 * implementation behind single-message delete and the bulk route, so the
 * non-idempotent classification and the intent identity are not written twice. A
 * `DELETE` is not a move to the deleted-items folder — that is a move, and the
 * caller decides which of the two Inboxora's "delete" means.
 */
export type DeleteGraphMessageResult = { deleted: true } | { deleted: false; code?: string };

export async function deleteGraphMessagePermanently(input: {
  userId: string;
  accountId: string;
  connectionId: string;
  config?: GraphApiOptions['config'];
  immutableIds?: boolean;
  /** The local `messages.id`. */
  resourceId: string;
  providerMessageId: string;
}): Promise<DeleteGraphMessageResult> {
  const immutableIds = input.immutableIds ?? await immutableIdsEnabled(input.connectionId);
  const payload = { providerMessageId: input.providerMessageId, intentAt: new Date().toISOString() };
  const result = await runProviderMutation(
    {
      userId: input.userId,
      channel: 'web',
      operation: 'delete',
      accountId: input.accountId,
      resourceId: input.resourceId,
      ...graphDeleteIntent(payload),
      payload,
      retry: { delaySeconds: 300 },
    },
    graphDeleteMutationAdapter({
      api: {
        userId: input.userId,
        connectionId: input.connectionId,
        ...(input.config ? { config: input.config } : {}),
        immutableIds,
      },
    }),
  );
  if (result.status === 'confirmed' || result.status === 'accepted') return { deleted: true };
  return { deleted: false, ...(result.code ? { code: result.code } : {}) };
}
