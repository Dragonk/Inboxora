import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db.js';
import { ProviderAuthError } from '../../providerAuthService.js';
import { GraphApiError } from './graphApiClient.js';
import type { GraphApiOptions } from './graphApiClient.js';
import { readGraphStableLocation } from './graphStableLocation.js';
import { lockGraphMailWrites, projectGraphMove } from './graphMailContinuity.js';
import { immutableIdsEnabled } from './graphMessageIdType.js';

const FIRST_VERIFY_DELAY_SECONDS = 60;
const RETRY_DELAY_SECONDS = 60;
const CLAIM_STALE_MINUTES = 10;

interface PendingRemoval {
  message_row_id: string;
  account_id: string;
  connection_id: string;
  synced_at: string | null;
  provider_message_id: string;
  internet_message_id: string | null;
  source_folder_path: string;
  source_folder_remote_id: string;
  attempts: number;
  claimed_at: string;
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
       claimed_at = NULL,
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
       claimed_at = NULL,
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
        attempts,
        claimed_at::text AS claimed_at,
        account_id, connection_id,
        (SELECT m.synced_at::text FROM messages m WHERE m.id = pending.message_row_id) AS synced_at`,
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

async function clearPending(row: PendingRemoval): Promise<boolean> {
  const result = await query(
    `DELETE FROM graph_pending_message_removals
      WHERE message_row_id = $1
        AND claimed_at = $2::timestamptz
        AND provider_message_id = $3`,
    [
      row.message_row_id,
      row.claimed_at,
      row.provider_message_id,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function deferPending(
  row: PendingRemoval,
  code: string,
  incrementAttempt: boolean,
  retryDelaySeconds = RETRY_DELAY_SECONDS,
): Promise<boolean> {
  const result = await query(
    `UPDATE graph_pending_message_removals
        SET claimed_at = NULL,
            attempts = attempts + CASE WHEN $3 THEN 1 ELSE 0 END,
            last_error_code = $2,
            verify_after = NOW() + make_interval(secs => $4),
            updated_at = NOW()
      WHERE message_row_id = $1
        AND claimed_at = $5::timestamptz
        AND provider_message_id = $6`,
    [
      row.message_row_id,
      code,
      incrementAttempt,
      retryDelaySeconds,
      row.claimed_at,
      row.provider_message_id,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function confirmedDelete(row: PendingRemoval): Promise<boolean> {
  return withTransaction(async client => {
    await lockGraphMailWrites(client, row.account_id);
    // Consume the exact claim first. If a normal delta proved that the mail
    // exists, it has already cleared this row. A later worker also carries a
    // different claimed_at value.
    const owned = await client.query<{
      source_folder_path: string;
      provider_message_id: string;
    }>(
      `DELETE FROM graph_pending_message_removals
        WHERE message_row_id = $1
          AND claimed_at = $2::timestamptz
          AND provider_message_id = $3
        RETURNING source_folder_path, provider_message_id`,
      [
        row.message_row_id,
        row.claimed_at,
        row.provider_message_id,
      ],
    );

    const claim = owned.rows[0];
    if (!claim) return false;

    // Identity and source-folder fences also protect the ImmutableId transition:
    // if the message row was rebound after this candidate was created, the stale
    // candidate cannot delete it.
    const removed = await client.query(
      `DELETE FROM messages
        WHERE id = $1
          AND folder = $2
          AND provider_message_id = $3
          AND synced_at IS NOT DISTINCT FROM $4::timestamptz`,
      [
        row.message_row_id,
        claim.source_folder_path,
        claim.provider_message_id,
        row.synced_at,
      ],
    );

    return (removed.rowCount ?? 0) > 0;
  });
}

/** Relocate only the claimed version of the same verified provider object. */
async function relocate(row: PendingRemoval, providerMessageId: string, folderPath: string): Promise<boolean> {
  return withTransaction(async client => {
    await lockGraphMailWrites(client, row.account_id);
    const owned = await client.query(
      `DELETE FROM graph_pending_message_removals WHERE message_row_id=$1
         AND claimed_at=$2::timestamptz AND provider_message_id=$3 AND source_folder_path=$4`,
      [row.message_row_id,row.claimed_at,row.provider_message_id,row.source_folder_path],
    );
    if (!(owned.rowCount ?? 0)) return false;
    const current = await client.query(
      `SELECT id FROM messages WHERE id=$1 AND account_id=$2 AND provider_message_id=$3 AND folder=$4
         AND synced_at IS NOT DISTINCT FROM $5::timestamptz FOR UPDATE`,
      [row.message_row_id,row.account_id,row.provider_message_id,row.source_folder_path,row.synced_at],
    );
    if (!(current.rowCount ?? 0)) return false;
    return (await projectGraphMove(client, {
      accountId:row.account_id,connectionId:row.connection_id,rowId:row.message_row_id,
      sourceId:row.provider_message_id,targetId:providerMessageId,targetPath:folderPath,
    })).moved;
  });
}

/**
 * Reconcile one physical Graph object, using a validated immutable identity.
 * RFC Message-ID matches and account-level mode flags alone never authorize a
 * rebind or deletion. HTTP failures are deferred; successful actions retain the
 * claim, source-identity and message-version fences.
 */
export async function processGraphPendingRemovals(input: {
  userId: string;
  connectionId: string;
  accountId: string;
  config?: GraphApiOptions['config'];
  fetchImpl?: GraphApiOptions['fetchImpl'];
  limit?: number;
}): Promise<PendingRemovalSummary> {
  const immutableIds = await immutableIdsEnabled(input.connectionId);
  const rows = await claimDue(
    input.connectionId,
    input.accountId,
    Math.min(Math.max(input.limit ?? 10, 1), 50),
  );

  const summary: PendingRemovalSummary = {
    claimed: rows.length,
    kept: 0,
    relocated: 0,
    deleted: 0,
    deferred: 0,
  };

  if (!rows.length) return summary;

  const api: GraphApiOptions = {
    userId: input.userId,
    connectionId: input.connectionId,
    immutableIds,
    ...(input.config ? { config: input.config } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  };

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]!;

    try {
      const current = await readGraphStableLocation(api, row.provider_message_id);
      if (current.kind === 'gone') {
        if (await confirmedDelete(row)) summary.deleted += 1;
        continue;
      }
      if (current.id === row.provider_message_id && current.parentFolderId === row.source_folder_remote_id) {
        if (await clearPending(row)) summary.kept += 1;
        continue;
      }
      const path = await destinationPath(input.connectionId, input.accountId, current.parentFolderId);
      if (!path) {
        // Unknown local mapping is not proof that a still-existing mail should be destroyed.
        if (await deferPending(row, 'GRAPH_DESTINATION_UNKNOWN', true,
          Math.min(3600, 60 * 2 ** Math.min(row.attempts, 6)))) summary.deferred += 1;
        continue;
      }
      if (await relocate(row, current.id, path)) summary.relocated += 1;
    } catch (caught) {
      const code =
        caught instanceof ProviderAuthError
          ? caught.code
          : caught instanceof GraphApiError
            ? caught.code
            : 'INTERNAL_ERROR';

      const retryDelay =
        caught instanceof GraphApiError && caught.retryAfterSeconds
          ? Math.max(RETRY_DELAY_SECONDS, caught.retryAfterSeconds)
          : RETRY_DELAY_SECONDS;

      if (await deferPending(row, code, false, retryDelay)) {
        summary.deferred += 1;
      }

      const fatal =
        caught instanceof ProviderAuthError
        || (
          caught instanceof GraphApiError
          && (
            caught.code === 'PROVIDER_AUTH_REQUIRED'
            || caught.code === 'INSUFFICIENT_SCOPES'
          )
        );

      const throttled =
        caught instanceof GraphApiError
        && caught.code === 'RATE_LIMITED';

      if (fatal || throttled) {
        // Do not leave the rest of this batch claimed for ten minutes and do
        // not keep hammering Graph after a 429 or unusable authorization.
        for (const rest of rows.slice(rowIndex + 1)) {
          if (await deferPending(rest, code, false, retryDelay)) {
            summary.deferred += 1;
          }
        }

        if (fatal) throw caught;
        break;
      }
    }
  }

  return summary;
}
