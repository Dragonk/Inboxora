import type { PoolClient } from 'pg';
import { withTransaction } from './db.js';

/**
 * Disconnect a provider connection a user no longer wants.
 *
 * The data-retention choice is made here and deliberately conservative: the grant is revoked and
 * its stored tokens are deleted, the connection stops being active so no schedule touches it, and
 * the imported collections are disabled so nothing refreshes — but **no imported contact, calendar
 * or event is deleted**. Those are the user's data, they stay visible, and removing them is a
 * separate decision that deserves its own request rather than being a side effect of disconnecting.
 *
 * Reconnecting the same provider account reactivates the connection through the normal
 * authorization flow, which re-links the same collections by remote id.
 */

export interface DisconnectResult {
  connectionId: string;
  /** Collections that stopped refreshing, for the caller to report. */
  collectionsDisabled: number;
}

/** Revoke one connection owned by `userId`. Returns null when the user has no such connection. */
export async function disconnectProviderConnection(userId: string, connectionId: string): Promise<DisconnectResult | null> {
  return withTransaction(async (client: PoolClient) => {
    const owned = await client.query<{ id: string }>(
      'SELECT id FROM provider_connections WHERE id = $1 AND user_id = $2',
      [connectionId, userId],
    );
    if (!owned.rows.length) return null;

    // Tokens are removed rather than left encrypted at rest: a revoked grant has no use for them,
    // and a stored refresh token is the thing worth not keeping.
    await client.query(
      `UPDATE oauth_grants
          SET status = 'revoked', access_token_encrypted = NULL, refresh_token_encrypted = NULL,
              refresh_lease_owner = NULL, refresh_lease_expires_at = NULL, updated_at = NOW()
        WHERE connection_id = $1`,
      [connectionId],
    );
    await client.query(
      `UPDATE provider_connections SET status = 'revoked', updated_at = NOW() WHERE id = $1`,
      [connectionId],
    );
    // The schedule selects `enabled` collections, so disabling them is what stops the refresh.
    const disabled = await client.query(
      `UPDATE integration_collections SET enabled = false, updated_at = NOW()
        WHERE connection_id = $1 AND enabled = true`,
      [connectionId],
    );
    return { connectionId, collectionsDisabled: disabled.rowCount ?? 0 };
  });
}
