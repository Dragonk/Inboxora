import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db.js';
import { GraphApiError } from './graphApiClient.js';
import type { GraphApiOptions } from './graphApiClient.js';
import {
  fetchGraphMessageLocation,
  findGraphMessagesByInternetMessageId,
  providerUidForGraphMessage,
} from './graphMail.js';
import { immutableIdsEnabled } from './graphMessageIdType.js';

const FIRST_VERIFY_DELAY_SECONDS = 60;
const RETRY_DELAY_SECONDS = 60;
const CLAIM_STALE_MINUTES = 10;

interface PendingRemoval {
  message_row_id: string;
  provider_message_id: string;
  internet_message_id: string | null;
  source_folder_path: string;
  source_folder_remote_id: string;
  attempts: number;
}

export interface PendingRemovalSummary {
  claimed: number;
  kept: number;
  relocated: number;
  deleted: number;
  deferred: number;
}

/**
 * Record an ambiguous folder tombstone without deleting the message.
 *
 * Repeated tombstones never push verify_after further into the future; once a
 * removal is pending, it will eventually be reconciled.
 */
export async function enqueueGraphPendingRemoval(
  client: PoolClient,
  input: {
    connectionId: string;
    accountId: string;
    providerMessageId: string;
    sourceFolderPath: string;
    sourceFolderRemoteId: string;
  },
): Promise<boolean> {
  const local = await client.query<{ id: string; message_id: string | null }>(
    `SELECT id, message_id
       FROM messages
      WHERE account_id = $1
        AND provider_message_id = $2
        AND folder = $3
      LIMIT 1`,
    [input.accountId, input.providerMessageId, input.sourceFolderPath],
  );

  const row = local.rows[0];
  if (!row) return false;

  await client.query(
    `INSERT INTO graph_pending_message_removals AS pending (
       message_row_id,
       connection_id,
       account_id,
       provider_message_id,
       internet_message_id,
       source_folder_path,
       source_folder_remote_id,
       verify_after
     )
     VALUES (
       $1,$2,$3,$4,$5,$6,$7,
       NOW() + make_interval(secs => $8)
     )
     ON CONFLICT (message_row_id) DO UPDATE SET
       provider_message_id = EXCLUDED.provider_message_id,
       internet_message_id = COALESCE(EXCLUDED.internet_message_id, pending.internet_message_id),
       source_folder_path = EXCLUDED.source_folder_path,
       source_folder_remote_id = EXCLUDED.source_folder_remote_id,
       verify_after = LEAST(pending.verify_after, EXCLUDED.verify_after),
       updated_at = NOW()`,
    [
      row.id,
      input.connectionId,
      input.accountId,
      input.providerMessageId,
      row.message_id,
      input.sourceFolderPath,
      input.sourceFolderRemoteId,
      FIRST_VERIFY_DELAY_SECONDS,
    ],
  );

  return true;
}

/**
 * A normal provider page proved that this physical row still exists.
 */
export async function clearGraphPendingRemoval(
  client: PoolClient,
  messageRowId: string,
): Promise<void> {
  await client.query(
    'DELETE FROM graph_pending_message_removals WHERE message_row_id = $1',
    [messageRowId],
  );
}

/**
 * After a completed full baseline, rows not refreshed by that baseline become
 * reconciliation candidates — never immediate deletions.
 */
export async function enqueueGraphBaselineRemovalCandidates(
  client: PoolClient,
  input: {
    connectionId: string;
    accountId: string;
    sourceFolderPath: string;
    sourceFolderRemoteId: string;
    baselineStartedAt: string;
  },
): Promise<number> {
  const result = await client.query(
    `INSERT INTO graph_pending_message_removals AS pending (
       message_row_id,
       connection_id,
       account_id,
       provider_message_id,
       internet_message_id,
       source_folder_path,
       source_folder_remote_id,
       verify_after
     )
     SELECT
       m.id,
       $1,
       $2,
       m.provider_message_id,
       m.message_id,
       $3,
       $4,
       NOW() + make_interval(secs => $6)
     FROM messages m
     WHERE m.account_id = $2
       AND m.folder = $3
       AND m.provider_message_id IS NOT NULL
       AND (m.synced_at IS NULL OR m.synced_at < $5::timestamptz)
     ON CONFLICT (message_row_id) DO UPDATE SET
       provider_message_id = EXCLUDED.provider_message_id,
       internet_message_id = COALESCE(EXCLUDED.internet_message_id, pending.internet_message_id),
       source_folder_path = EXCLUDED.source_folder_path,
       source_folder_remote_id = EXCLUDED.source_folder_remote_id,
       verify_after = LEAST(pending.verify_after, EXCLUDED.verify_after),
       updated_at = NOW()`,
    [
      input.connectionId,
      input.accountId,
      input.sourceFolderPath,
      input.sourceFolderRemoteId,
      input.baselineStartedAt,
      FIRST_VERIFY_DELAY_SECONDS,
    ],
  );

  return result.rowCount ?? 0;
}

async function claimDue(
  connectionId: string,
  accountId: string,
  limit: number,
): Promise<PendingRemoval[]> {
  const result = await query<PendingRemoval>(
    `UPDATE graph_pending_message_removals pending
        SET claimed_at = NOW(),
            updated_at = NOW()
      WHERE pending.message_row_id IN (
        SELECT message_row_id
          FROM graph_pending_message_removals
         WHERE connection_id = $1
           AND account_id = $2
           AND verify_after <= NOW()
           AND (
             claimed_at IS NULL
             OR claimed_at <= NOW() - make_interval(mins => $4)
           )
         ORDER BY verify_after
         FOR UPDATE SKIP LOCKED
         LIMIT $3
      )
      RETURNING
        message_row_id,
        provider_message_id,
        internet_message_id,
        source_folder_path,
        source_folder_remote_id,
        attempts`,
    [connectionId, accountId, limit, CLAIM_STALE_MINUTES],
  );

  return result.rows;
}

async function destinationPath(
  connectionId: string,
  accountId: string,
  remoteFolderId: string,
): Promise<string | null> {
  const result = await query<{ path: string }>(
    `SELECT f.path
       FROM integration_collections ic
       JOIN folders f ON f.id = ic.local_folder_id
      WHERE ic.connection_id = $1
        AND ic.kind = 'mail_folder'
        AND ic.enabled = true
        AND ic.remote_id = $2
        AND (
          ic.account_id = $3
          OR (ic.account_id IS NULL AND f.account_id = $3)
        )
      LIMIT 1`,
    [connectionId, remoteFolderId, accountId],
  );

  return result.rows[0]?.path ?? null;
}

async function clearPending(messageRowId: string): Promise<void> {
  await query(
    'DELETE FROM graph_pending_message_removals WHERE message_row_id = $1',
    [messageRowId],
  );
}

async function deferPending(
  messageRowId: string,
  code: string,
  incrementAttempt: boolean,
  retryDelaySeconds = RETRY_DELAY_SECONDS,
): Promise<void> {
  await query(
    `UPDATE graph_pending_message_removals
        SET claimed_at = NULL,
            attempts = attempts + CASE WHEN $3 THEN 1 ELSE 0 END,
            last_error_code = $2,
            verify_after = NOW() + make_interval(secs => $4),
            updated_at = NOW()
      WHERE message_row_id = $1`,
    [messageRowId, code, incrementAttempt, retryDelaySeconds],
  );
}

async function confirmedDelete(messageRowId: string): Promise<void> {
  await withTransaction(async client => {
    await client.query('DELETE FROM messages WHERE id = $1', [messageRowId]);

    // The FK normally cascades this, but also clear explicitly for the case where
    // another worker already removed the message.
    await client.query(
      'DELETE FROM graph_pending_message_removals WHERE message_row_id = $1',
      [messageRowId],
    );
  });
}

async function relocate(
  row: PendingRemoval,
  providerMessageId: string,
  folderPath: string,
): Promise<void> {
  await withTransaction(async client => {
    // Resolve the account from the physical row. Keeping the lookup here avoids
    // trusting any caller-supplied account identifier.
    const owner = await client.query<{ account_id: string }>(
      'SELECT account_id FROM messages WHERE id = $1',
      [row.message_row_id],
    );
    const accountId = owner.rows[0]?.account_id;

    if (!accountId) {
      await client.query(
        'DELETE FROM graph_pending_message_removals WHERE message_row_id = $1',
        [row.message_row_id],
      );
      return;
    }

    // A destination delta may already have inserted this exact provider object.
    // Keep the original Inboxora row because it owns local state and annotations;
    // remove only a duplicate proven by provider identity, never by derived UID.
    await client.query(
      `DELETE FROM messages
        WHERE account_id = $1
          AND provider_message_id = $2
          AND id <> $3`,
      [accountId, providerMessageId, row.message_row_id],
    );

    // providerUidForGraphMessage is deterministic but the legacy UID uniqueness
    // constraint can still collide with an unrelated message. Find a free derived
    // UID instead of deleting the unrelated row.
    let rebound = false;

    for (let attempt = 0; attempt < 3 && !rebound; attempt++) {
      const candidateUid = providerUidForGraphMessage(providerMessageId, attempt);

      const occupied = await client.query(
        `SELECT 1
           FROM messages
          WHERE account_id = $1
            AND uid = $2
            AND folder = $3
            AND id <> $4
          LIMIT 1`,
        [accountId, candidateUid, folderPath, row.message_row_id],
      );

      if ((occupied.rowCount ?? 0) > 0) continue;

      const updated = await client.query(
        `UPDATE messages
            SET folder = $1,
                provider_message_id = $2,
                uid = $3,
                synced_at = NOW()
          WHERE id = $4`,
        [folderPath, providerMessageId, candidateUid, row.message_row_id],
      );

      rebound = (updated.rowCount ?? 0) > 0;
    }

    if (!rebound) {
      throw new Error(`Unable to allocate a collision-free UID while relocating ${row.message_row_id}`);
    }

    await client.query(
      'DELETE FROM graph_pending_message_removals WHERE message_row_id = $1',
      [row.message_row_id],
    );
  });
}

/**
 * Reconcile due tombstones.
 *
 * Mutable Graph ids require two independent negative checks separated in time.
 * Immutable ids require only the delayed direct 404 because they survive moves
 * within the mailbox.
 */
export async function processGraphPendingRemovals(input: {
  userId: string;
  connectionId: string;
  accountId: string;
  config?: GraphApiOptions['config'];
  fetchImpl?: GraphApiOptions['fetchImpl'];
  limit?: number;
}): Promise<PendingRemovalSummary> {
  const rows = await claimDue(
    input.connectionId,
    input.accountId,
    Math.min(Math.max(input.limit ?? 50, 1), 200),
  );

  const summary: PendingRemovalSummary = {
    claimed: rows.length,
    kept: 0,
    relocated: 0,
    deleted: 0,
    deferred: 0,
  };

  if (!rows.length) return summary;

  const immutableIds = await immutableIdsEnabled(input.connectionId);

  const api: GraphApiOptions = {
    userId: input.userId,
    connectionId: input.connectionId,
    immutableIds,
    ...(input.config ? { config: input.config } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  };

  for (const row of rows) {
    try {
      const direct = await fetchGraphMessageLocation(api, row.provider_message_id);

      if (direct) {
        if (!direct.parentFolderId) {
          await deferPending(row.message_row_id, 'GRAPH_FOLDER_UNKNOWN', false);
          summary.deferred += 1;
          continue;
        }

        if (direct.parentFolderId === row.source_folder_remote_id) {
          await clearPending(row.message_row_id);
          summary.kept += 1;
          continue;
        }

        const path = await destinationPath(
          input.connectionId,
          input.accountId,
          direct.parentFolderId,
        );

        if (!path) {
          await deferPending(row.message_row_id, 'GRAPH_DESTINATION_UNKNOWN', false);
          summary.deferred += 1;
          continue;
        }

        await relocate(row, direct.id, path);
        summary.relocated += 1;
        continue;
      }

      // Immutable Graph identity survives moves inside the mailbox. After the
      // grace period, a direct 404 is therefore authoritative.
      if (immutableIds) {
        await confirmedDelete(row.message_row_id);
        summary.deleted += 1;
        continue;
      }

      const internetMessageId = row.internet_message_id?.trim() ?? '';

      // Without an independent identity a mutable-id 404 cannot authorize a
      // destructive operation.
      if (!internetMessageId) {
        await deferPending(row.message_row_id, 'GRAPH_NO_STABLE_ID', false);
        summary.deferred += 1;
        continue;
      }

      const matches = await findGraphMessagesByInternetMessageId(api, internetMessageId);

      if (matches.length > 1) {
        await deferPending(row.message_row_id, 'GRAPH_IDENTITY_AMBIGUOUS', false);
        summary.deferred += 1;
        continue;
      }

      if (matches.length === 1) {
        const match = matches[0]!;

        if (!match.parentFolderId) {
          await deferPending(row.message_row_id, 'GRAPH_FOLDER_UNKNOWN', false);
          summary.deferred += 1;
          continue;
        }

        const path = await destinationPath(
          input.connectionId,
          input.accountId,
          match.parentFolderId,
        );

        if (!path) {
          await deferPending(row.message_row_id, 'GRAPH_DESTINATION_UNKNOWN', false);
          summary.deferred += 1;
          continue;
        }

        await relocate(row, match.id, path);
        summary.relocated += 1;
        continue;
      }

      // A mutable Graph id is not durable deletion authority. Live Outlook
      // mailboxes have demonstrated that the old id can 404 while the message
      // still exists, and an immediate RFC lookup may also temporarily return
      // no match. Never physically delete such a row.
      //
      // Keep the durable candidate so a later delta can cancel it or relocate
      // it. Once the mailbox has been migrated to ImmutableId, the immutable
      // branch above may safely authorize deletion.
      await deferPending(
        row.message_row_id,
        'GRAPH_DELETE_REQUIRES_IMMUTABLE_ID',
        false,
        300,
      );
      summary.deferred += 1;
    } catch (caught) {
      const code = caught instanceof GraphApiError
        ? caught.code
        : 'INTERNAL_ERROR';

      const retryDelay =
        caught instanceof GraphApiError && caught.retryAfterSeconds
          ? Math.max(RETRY_DELAY_SECONDS, caught.retryAfterSeconds)
          : RETRY_DELAY_SECONDS;

      await deferPending(row.message_row_id, code, false, retryDelay);
      summary.deferred += 1;
    }
  }

  return summary;
}
