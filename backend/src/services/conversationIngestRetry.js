import { query } from './db.js';
import { claimConversationIngestFailures, resolveConversationIngestFailure } from './conversationIngestFailures.js';
import { resolveOwnIdentityAddresses } from './conversationIngestEnvelope.js';
import { upsertConversationCopy } from './conversationPersistence.js';
import { providerIdentityForCopy } from './conversationProviderEnvelope.js';

export async function retryConversationIngestFailures({ userId = null, limit = 25 } = {}) {
  const failures = await claimConversationIngestFailures({ userId, limit });
  const results = [];
  for (const failure of failures) {
    try {
      const row = await query(`SELECT m.*, a.user_id, a.email_address FROM messages m JOIN email_accounts a ON a.id = m.account_id WHERE m.id = $1 AND a.user_id = $2`, [failure.message_row_id, failure.user_id]);
      if (row.rows.length !== 1) throw new Error('Message row no longer exists');
      const account = row.rows[0];
      const identities = await resolveOwnIdentityAddresses({ query }, account.account_id, account);
      await upsertConversationCopy(row.rows[0], {
        identities,
        provider: providerIdentityForCopy(row.rows[0]),
      });
      await resolveConversationIngestFailure(failure.id);
      results.push({ id: failure.id, resolved: true });
    } catch (error) {
      results.push({ id: failure.id, resolved: false, error: error.message });
    }
  }
  return results;
}
