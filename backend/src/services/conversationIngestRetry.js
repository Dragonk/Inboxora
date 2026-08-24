import { withTransaction } from './db.js';
import { claimConversationIngestFailures, resolveConversationIngestFailure } from './conversationIngestFailures.js';
import { resolveOwnIdentityAddresses } from './conversationIngestEnvelope.js';
import { _upsertConversationCopyWithClient } from './conversationPersistence.js';
import { providerIdentityForCopy } from './conversationProviderEnvelope.js';

export async function retryConversationIngestFailures({ userId = null, limit = 25 } = {}) {
  const failures = await claimConversationIngestFailures({ userId, limit });
  const results = [];
  for (const failure of failures) {
    try {
      // P1-18: The retry path must use the SAME transaction client for identity
      // resolution, provider decision, and persistence. The previous implementation
      // used a pool-level query() to load the message row (outside any transaction),
      // then called upsertConversationCopy() which started its own transaction.
      // That created a TOCTOU gap: the message row could be deleted/modified between
      // the pool-level SELECT and the transactional FOR UPDATE inside upsert.
      //
      // Now we wrap the entire flow in a single serializable transaction:
      //   1. SELECT the message row FOR UPDATE (same client)
      //   2. resolveOwnIdentityAddresses with the same client
      //   3. _upsertConversationCopyWithClient with the same client
      // This mirrors the pattern used by conversationRebuild.js.
      const result = await withTransaction(async client => {
        const row = await client.query(
          `SELECT m.*, a.user_id, a.email_address
             FROM messages m
             JOIN email_accounts a ON a.id = m.account_id
            WHERE m.id = $1 AND a.user_id = $2
            FOR UPDATE`,
          [failure.message_row_id, failure.user_id],
        );
        if (row.rows.length !== 1) throw new Error('Message row no longer exists');
        const account = row.rows[0];
        const identities = await resolveOwnIdentityAddresses(client, account.account_id, account);
        return _upsertConversationCopyWithClient(client, row.rows[0], {
          identities,
          provider: providerIdentityForCopy(row.rows[0]),
          userId: failure.user_id,
        });
      }, { serializable: true });
      await resolveConversationIngestFailure(failure.id);
      results.push({ id: failure.id, resolved: true, ...result });
    } catch (error) {
      results.push({ id: failure.id, resolved: false, error: error.message });
    }
  }
  return results;
}
