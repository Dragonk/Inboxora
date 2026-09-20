import { stopGoogleSubscriptionsForConnection } from './providerPushGoogle.js';
import { stopGraphSubscriptionsForConnection } from './providerPushMicrosoft.js';
import { markSubscriptionsRemoved } from './providerPushSubscriptions.js';
import { clearSyncHintsForConnection } from './providerSyncHints.js';
import { query } from './db.js';
import type { FetchLike } from './providerAuthService.js';

/**
 * One way to release a connection's push subscriptions, used by every lifecycle path.
 *
 * A disconnect, an account delete, a disabled provider or a revoked grant all mean the same thing to the
 * provider-side subscriptions: stop them, mark them removed locally, and drop the sync hints that were
 * waiting for them. The remote call is best effort and always followed by the local tombstone, because the
 * alternative — a cleanup that fails and leaves a renewal sweep running for something that is gone — is
 * exactly the zombie this exists to prevent.
 */
export async function releaseProviderPushForConnection(input: {
  userId: string;
  connectionId: string;
  fetchImpl?: FetchLike;
}): Promise<{ provider: string | null; attempted: number; failed: number }> {
  const connection = await query<{ provider: string }>(
    'SELECT provider FROM provider_connections WHERE id = $1 AND user_id = $2',
    [input.connectionId, input.userId],
  );
  const provider = connection.rows[0]?.provider ?? null;
  let attempted = 0;
  let failed = 0;
  try {
    const outcome = provider === 'microsoft'
      ? await stopGraphSubscriptionsForConnection({
        userId: input.userId, connectionId: input.connectionId,
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      })
      : provider === 'google'
        ? await stopGoogleSubscriptionsForConnection({
          userId: input.userId, connectionId: input.connectionId,
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        })
        : { attempted: 0, failed: 0 };
    attempted = outcome.attempted;
    failed = outcome.failed;
  } catch (error) {
    console.warn(`Push cleanup for connection ${input.connectionId} failed:`, error instanceof Error ? error.message : error);
  } finally {
    // Whatever the provider said, nothing here may be renewed or synced again.
    await markSubscriptionsRemoved({ connectionId: input.connectionId }).catch(() => {});
    await clearSyncHintsForConnection(input.connectionId).catch(() => {});
  }
  return { provider, attempted, failed };
}

/** Mark a connection's subscriptions disabled, without touching the provider (a provider was switched off). */
export async function disableProviderPushForConnection(connectionId: string): Promise<number> {
  return markSubscriptionsRemoved({ connectionId, status: 'disabled' });
}
