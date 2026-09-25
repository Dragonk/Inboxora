import type { PoolClient } from 'pg';
import { withTransaction } from './db.js';

export interface AccountDeletionPlan {
  accountId: string;
  userId: string;
  emailAddress: string;
  directConnectionId: string | null;
  connectionsToDelete: string[];
  invitationReferences: number;
}

export interface AccountDeletionResult {
  calendars: number;
  addressBooks: number;
}

interface AccountRow {
  id: string;
  user_id: string;
  email_address: string;
  provider_connection_id: string | null;
}

/**
 * Provider connections that belong exclusively to one Inboxora account.
 *
 * A provider identity can acquire more than one provider_connection over its
 * lifetime (separate consent/cutover rows). Collection ownership is therefore
 * evidence too. We deliberately refuse to delete a connection when another
 * email_accounts row still points at it, has the same verified provider identity,
 * or owns one of its account-scoped collections.
 */
async function exclusiveProviderConnections(
  client: Pick<PoolClient, 'query'>,
  account: AccountRow,
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT DISTINCT pc.id
       FROM provider_connections pc
       LEFT JOIN integration_collections ic
         ON ic.connection_id = pc.id AND ic.user_id = pc.user_id
       LEFT JOIN folders f
         ON f.id = ic.local_folder_id
      WHERE pc.user_id = $1
        AND pc.provider IN ('google', 'microsoft')
        AND (
          pc.id = $3
          OR ic.account_id = $2
          OR (ic.kind IN ('mail_folder', 'mail_label') AND f.account_id = $2)
          OR (
            pc.provider_user_id IS NOT NULL
            AND lower(pc.provider_user_id) = lower($4)
          )
        )
        AND NOT EXISTS (
          SELECT 1
            FROM email_accounts other
           WHERE other.user_id = $1
             AND other.id <> $2
             AND (
               other.provider_connection_id = pc.id
               OR (
                 pc.provider_user_id IS NOT NULL
                 AND lower(other.email_address) = lower(pc.provider_user_id)
               )
             )
        )
        AND NOT EXISTS (
          SELECT 1
            FROM integration_collections other_ic
           WHERE other_ic.connection_id = pc.id
             AND other_ic.user_id = $1
             AND other_ic.account_id IS NOT NULL
             AND other_ic.account_id <> $2
        )
      ORDER BY pc.id`,
    [account.user_id, account.id, account.provider_connection_id, account.email_address],
  );
  return result.rows.map(row => row.id);
}

export async function accountDeletionPlan(userId: string, accountId: string): Promise<AccountDeletionPlan | null> {
  return withTransaction(async client => {
    const account = await client.query<AccountRow>(
      `SELECT id, user_id, email_address, provider_connection_id
         FROM email_accounts
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [accountId, userId],
    );
    const row = account.rows[0];
    if (!row) return null;

    const invitationRefs = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM calendar_events
        WHERE invite_account_id = $1`,
      [accountId],
    );

    return {
      accountId,
      userId,
      emailAddress: row.email_address,
      directConnectionId: row.provider_connection_id,
      connectionsToDelete: await exclusiveProviderConnections(client, row),
      invitationReferences: invitationRefs.rows[0]?.count ?? 0,
    };
  });
}

/**
 * Remove the account and all local projections that belong only to provider
 * connections being retired with it.
 *
 * Deleting integration_collections alone is insufficient: their foreign keys to
 * calendars/address_books are ON DELETE SET NULL, so the local provider projection
 * survives and the settings UI can resurrect it as an orphan source. Delete the
 * projected resources first, then the connection, then the mailbox, atomically.
 *
 * No remote calendar/contact resource is deleted here. This only removes Inboxora's
 * local projections and authorization state.
 */
export async function deleteAccountWithProviderArtifacts(
  userId: string,
  accountId: string,
  plan: AccountDeletionPlan,
): Promise<AccountDeletionResult | null> {
  return withTransaction(async client => {
    const locked = await client.query<AccountRow>(
      `SELECT id, user_id, email_address, provider_connection_id
         FROM email_accounts
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [accountId, userId],
    );
    if (!locked.rows[0]) return null;

    // Re-plan under the deletion transaction so a concurrently-added account cannot
    // turn an exclusive connection into a shared one between preview and commit.
    const currentConnections = await exclusiveProviderConnections(client, locked.rows[0]);
    const planned = new Set(plan.connectionsToDelete);
    const connections = currentConnections.filter(id => planned.has(id));

    let calendars = 0;
    let addressBooks = 0;

    if (connections.length > 0) {
      const calendarIds = await client.query<{ id: string }>(
        `SELECT DISTINCT c.id
           FROM calendars c
           JOIN integration_collections ic
             ON ic.local_calendar_id = c.id
            AND ic.kind = 'calendar'
            AND ic.user_id = c.user_id
          WHERE c.user_id = $1
            AND c.owner_user_id = $1
            AND c.source <> 'local'
            AND (
              ic.account_id = $2
              OR ic.connection_id = ANY($3::uuid[])
            )`,
        [userId, accountId, connections],
      );
      if (calendarIds.rows.length) {
        const removed = await client.query(
          `DELETE FROM calendars
            WHERE user_id = $1
              AND id = ANY($2::uuid[])`,
          [userId, calendarIds.rows.map(row => row.id)],
        );
        calendars = removed.rowCount ?? 0;
      }

      const bookIds = await client.query<{ id: string }>(
        `SELECT DISTINCT ab.id
           FROM address_books ab
           JOIN integration_collections ic
             ON ic.local_address_book_id = ab.id
            AND ic.kind = 'address_book'
            AND ic.user_id = ab.user_id
          WHERE ab.user_id = $1
            AND ab.source <> 'local'
            AND (
              ic.account_id = $2
              OR ic.connection_id = ANY($3::uuid[])
            )`,
        [userId, accountId, connections],
      );
      if (bookIds.rows.length) {
        const removed = await client.query(
          `DELETE FROM address_books
            WHERE user_id = $1
              AND id = ANY($2::uuid[])`,
          [userId, bookIds.rows.map(row => row.id)],
        );
        addressBooks = removed.rowCount ?? 0;
      }

      await client.query(
        `DELETE FROM provider_connections
          WHERE user_id = $1
            AND id = ANY($2::uuid[])`,
        [userId, connections],
      );
    }

    const deletedAccount = await client.query(
      'DELETE FROM email_accounts WHERE id = $1 AND user_id = $2 RETURNING id',
      [accountId, userId],
    );
    if (!deletedAccount.rows[0]) return null;

    return { calendars, addressBooks };
  });
}
