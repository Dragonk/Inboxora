import type { PoolClient } from 'pg';
import { query, withTransaction } from './db.js';
import { markSubscriptionsRemoved } from './providerPushSubscriptions.js';
import { stopGoogleSubscriptionsForConnection } from './providerPushGoogle.js';
import { stopGraphSubscriptionsForConnection } from './providerPushMicrosoft.js';
import { clearSyncHintsForConnection } from './providerSyncHints.js';

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

/**
 * Bring a connection back into service when its account is authorized again.
 *
 * A disconnect takes the connection out of service and disables its collections, so
 * re-authorization has to undo both: otherwise the new grant is stored against a connection the
 * status routes and the schedule both ignore, which looks exactly like a connection that never
 * worked. Runs inside the caller's transaction so the grant and the reactivation land together.
 */
export async function reactivateProviderConnection(
  client: Pick<PoolClient, 'query'>,
  connectionId: string,
): Promise<void> {
  await client.query(
    `UPDATE provider_connections SET status = 'active', updated_at = NOW()
      WHERE id = $1 AND status <> 'active'`,
    [connectionId],
  );
  await client.query(
    `UPDATE integration_collections SET enabled = true, updated_at = NOW()
      WHERE connection_id = $1 AND enabled = false`,
    [connectionId],
  );
}

/** Revoke one connection owned by `userId`. Returns null when the user has no such connection. */
/**
 * Provider-side push cleanup for a connection, best effort.
 *
 * A disconnect must complete even when the provider cannot be reached: the local rows are what stop the
 * renewal sweep, so they are always tombstoned, and the remote stop is attempted first only so that a
 * healthy provider does not keep a subscription alive for an account Inboxora no longer has.
 */
async function releasePushSubscriptions(userId: string, connectionId: string): Promise<void> {
  try {
    const provider = await query<{ provider: string }>(
      'SELECT provider FROM provider_connections WHERE id = $1 AND user_id = $2',
      [connectionId, userId],
    );
    const row = provider.rows[0];
    if (!row) return;
    const stopper = row.provider === 'microsoft' ? stopGraphSubscriptionsForConnection : stopGoogleSubscriptionsForConnection;
    await stopper({ userId, connectionId });
  } catch (error) {
    console.warn(`Push subscription cleanup for connection ${connectionId} failed:`, error instanceof Error ? error.message : error);
    // The local tombstone is the guarantee; leave it in place even when the remote call could not run.
    await markSubscriptionsRemoved({ connectionId }).catch(() => {});
  }
  // Whatever happened above, waiting hints for a disconnected connection must not run.
  await clearSyncHintsForConnection(connectionId).catch(() => {});
}

export async function disconnectProviderConnection(userId: string, connectionId: string): Promise<DisconnectResult | null> {
  const result = await withTransaction(async (client: PoolClient) => {
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
  // After the transaction commits: stop the provider-side subscriptions and drop any hint that was waiting.
  // Best effort by design — a provider outage must not keep a user from disconnecting an account.
  await releasePushSubscriptions(userId, connectionId);
  return result;
}
