import { query } from '../../db.js';
import { gmailFolderPathByLabelId, gmailLabelIdForPath } from './gmailMailSync.js';
import { gmailMoveIntent, gmailMoveMutationAdapter } from './gmailMailMutations.js';
import { runProviderMutation } from '../../providerMutationService.js';
import type { GoogleConfig } from '../../providerAuthService.js';
import { primaryFolderPathForGmailLabels } from './gmailLabels.js';

/**
 * Move and archive one Gmail API message, and re-home its local row.
 *
 * This is the single implementation behind every Gmail move — the bulk routes, spam
 * and ham, trash and the snooze wakeup — because the parts that matter (which label
 * the message leaves, which it enters, and what the local row then is) must not be
 * written twice.
 *
 * The property worth naming is the opposite of Graph's: a Gmail move **keeps the
 * message's identity**. Adding and removing labels does not re-identify the message,
 * so `provider_message_id` and the derived `uid` are untouched and only `folder` and
 * the stored label set change. That is also why the move is declared idempotent on
 * the mutation layer: re-applying a label change converges.
 */

export type MoveGmailMessageResult = { moved: true; folder: string } | { moved: false; code?: string };

/** The stored label set with one label added and others removed, in one statement. */
async function updateStoredLabels(input: {
  accountId: string;
  resourceId: string;
  addLabelIds: readonly string[];
  removeLabelIds: readonly string[];
  folder: string | null;
}): Promise<number> {
  if (input.folder === null) {
    // The message is archived and carries no modeled mailbox: the local row goes,
    // exactly as the ingest path removes it, rather than being filed under a folder
    // Gmail does not have.
    const removed = await query(
      'DELETE FROM messages WHERE id = $1 AND account_id = $2',
      [input.resourceId, input.accountId],
    );
    return removed.rowCount ?? 0;
  }
  const updated = await query(
    `UPDATE messages
        SET folder = $3,
            provider_labels = (
              SELECT array_agg(DISTINCT label ORDER BY label)
                FROM unnest(COALESCE(provider_labels, '{}'::text[]) || $4::text[]) AS label
               WHERE NOT (label = ANY($5::text[]))
            ),
            synced_at = NOW()
      WHERE id = $1 AND account_id = $2`,
    [input.resourceId, input.accountId, input.folder, [...input.addLabelIds], [...input.removeLabelIds]],
  );
  return updated.rowCount ?? 0;
}

/**
 * Move one Gmail message to the label a local folder path projects onto.
 *
 * `sourcePath` is the local folder the message is leaving. It is resolved to the
 * label that folder projects from and removed in the same call, which is what makes
 * a move on Gmail a move rather than a copy: without it the message would simply
 * gain the destination label and stay where it was. Archiving does **not** come
 * through here — it names no destination — and uses {@link archiveGmailMessage}.
 */
export async function moveGmailMessageToLabel(input: {
  userId: string;
  accountId: string;
  connectionId: string;
  config: GoogleConfig;
  /** The local `messages.id`. */
  resourceId: string;
  providerMessageId: string;
  destinationPath: string;
  /** The local folder being left, when there is one. */
  sourcePath?: string | null;
}): Promise<MoveGmailMessageResult> {
  const destinationLabelId = await gmailLabelIdForPath({
    connectionId: input.connectionId,
    accountId: input.accountId,
    path: input.destinationPath,
  });
  if (!destinationLabelId) return { moved: false, code: 'RESOURCE_NOT_FOUND' };

  const sourceLabelId = input.sourcePath
    ? await gmailLabelIdForPath({ connectionId: input.connectionId, accountId: input.accountId, path: input.sourcePath })
    : null;
  const removeLabelIds = sourceLabelId && sourceLabelId !== destinationLabelId ? [sourceLabelId] : [];
  const addLabelIds = [destinationLabelId];

  const payload = {
    providerMessageId: input.providerMessageId,
    addLabelIds,
    removeLabelIds,
    intentAt: new Date().toISOString(),
  };
  const result = await runProviderMutation(
    {
      userId: input.userId,
      channel: 'web',
      operation: 'update',
      accountId: input.accountId,
      resourceId: input.resourceId,
      ...gmailMoveIntent(payload),
      payload,
      retry: { delaySeconds: 300 },
    },
    gmailMoveMutationAdapter({
      api: {
        userId: input.userId,
        connectionId: input.connectionId,
        config: input.config,
      },
    }),
  );
  if (result.status !== 'confirmed' && result.status !== 'accepted') {
    return { moved: false, ...(result.code ? { code: result.code } : {}) };
  }

  const updated = await updateStoredLabels({
    accountId: input.accountId,
    resourceId: input.resourceId,
    addLabelIds,
    removeLabelIds,
    folder: input.destinationPath,
  });
  if (updated === 0) {
    // A concurrent sync removed the row; the destination's next thread re-read
    // re-ingests it, so this is a warning rather than a failure.
    console.warn(`Gmail move: the local row ${input.resourceId} was gone before it could be re-homed`);
  }
  return { moved: true, folder: input.destinationPath };
}

export type ArchiveGmailMessageResult = { archived: true; folder: string | null } | { archived: false; code?: string };

/**
 * Archive one Gmail message: remove `INBOX`, and nothing else.
 *
 * Gmail has no Archive label and no "move to Archive" — archiving *is* leaving the
 * inbox, and the message keeps every other label it has. So the local row is not
 * filed anywhere new: its folder becomes the first of its remaining labels that is a
 * mailbox, or the row is removed when no label is one, which is the same archived
 * state the ingest path models. Inventing an "Archive" folder here would give the
 * application a place Gmail does not have.
 */
export async function archiveGmailMessage(input: {
  userId: string;
  accountId: string;
  connectionId: string;
  config: GoogleConfig;
  resourceId: string;
  providerMessageId: string;
}): Promise<ArchiveGmailMessageResult> {
  const payload = {
    providerMessageId: input.providerMessageId,
    addLabelIds: [] as string[],
    removeLabelIds: ['INBOX'],
    intentAt: new Date().toISOString(),
  };
  const result = await runProviderMutation(
    {
      userId: input.userId,
      channel: 'web',
      operation: 'update',
      accountId: input.accountId,
      resourceId: input.resourceId,
      ...gmailMoveIntent(payload),
      payload,
      retry: { delaySeconds: 300 },
    },
    gmailMoveMutationAdapter({
      api: {
        userId: input.userId,
        connectionId: input.connectionId,
        config: input.config,
      },
    }),
  );
  if (result.status !== 'confirmed' && result.status !== 'accepted') {
    return { archived: false, ...(result.code ? { code: result.code } : {}) };
  }

  const pathByLabelId = await gmailFolderPathByLabelId({ connectionId: input.connectionId, accountId: input.accountId });
  const stored = await query<{ provider_labels: string[] | null }>(
    'SELECT provider_labels FROM messages WHERE id = $1 AND account_id = $2',
    [input.resourceId, input.accountId],
  );
  const labels = (stored.rows[0]?.provider_labels ?? []).filter(label => label !== 'INBOX');
  const folder = stored.rows.length > 0 ? primaryFolderPathForGmailLabels(labels, pathByLabelId) : null;
  await updateStoredLabels({
    accountId: input.accountId,
    resourceId: input.resourceId,
    addLabelIds: [],
    removeLabelIds: ['INBOX'],
    folder,
  });
  return { archived: true, folder };
}
