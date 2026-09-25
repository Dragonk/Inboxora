import { query } from './db.js';
import { googleConfigFromEnv, microsoftConfigFromEnv } from './providerAuthService.js';
import { extractHtmlTextForRules, parseHeadersInput } from './messageParser.js';
import { fetchGmailMessageContent, fetchGmailMessageHeaders } from './providers/google/gmailMailBody.js';
import { fetchGraphMessageBody, fetchGraphMessageHeaders } from './providers/microsoft/graphMailBody.js';

export interface ProviderRuleDataRequirements { needsBody: boolean; needsHeaders: boolean }

interface DeferredRow {
  id: string;
  message_id: string;
  account_id: string;
  user_id: string;
  connection_id: string;
  transport: 'gmail_api' | 'microsoft_graph';
  needs_body: boolean;
  needs_headers: boolean;
  dispatch_state: 'pending' | 'dispatching' | 'outcome_unknown';
}

const LEASE_SECONDS = 120;
const MAX_BACKOFF_SECONDS = 60 * 60;

/**
 * Persist a read-only deferral before any provider rule side effect. The unique message
 * key makes repeated sync pages harmless while retaining the union of missing inputs.
 */
export async function enqueueProviderRuleDeferral(input: {
  messageId: string;
  accountId: string;
  userId: string;
  connectionId: string;
  transport: 'gmail_api' | 'microsoft_graph';
  requirements: ProviderRuleDataRequirements;
}): Promise<void> {
  if (!input.requirements.needsBody && !input.requirements.needsHeaders) return;
  await query(
    `INSERT INTO provider_rule_deferred_messages
       (message_id, account_id, user_id, connection_id, transport, needs_body, needs_headers)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (message_id) DO UPDATE SET
       needs_body = provider_rule_deferred_messages.needs_body OR EXCLUDED.needs_body,
       needs_headers = provider_rule_deferred_messages.needs_headers OR EXCLUDED.needs_headers,
       available_at = LEAST(provider_rule_deferred_messages.available_at, NOW()),
       updated_at = NOW()`,
    [input.messageId, input.accountId, input.userId, input.connectionId, input.transport, input.requirements.needsBody, input.requirements.needsHeaders],
  );
}

async function retryRead(row: DeferredRow, owner: string, message: string): Promise<void> {
  await query(
    `UPDATE provider_rule_deferred_messages
        SET attempts = attempts + 1,
            available_at = NOW() + (LEAST($3, 5 * power(2, LEAST(attempts, 10))) * INTERVAL '1 second'),
            lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
      WHERE id = $1 AND lease_owner = $2`,
    [row.id, owner, MAX_BACKOFF_SECONDS],
  );
  console.warn(`Provider rule deferred read for ${row.message_id} will retry: ${message}`);
}

async function claim(limit: number, owner: string): Promise<DeferredRow[]> {
  const result = await query<DeferredRow>(
    `WITH candidates AS (
       SELECT id FROM provider_rule_deferred_messages
        WHERE available_at <= NOW()
          AND dispatch_state IN ('pending', 'dispatching')
          AND action_started_at IS NULL
          AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
        ORDER BY available_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE provider_rule_deferred_messages queue
        SET lease_owner = $2, lease_expires_at = NOW() + ($3 * INTERVAL '1 second'), updated_at = NOW()
       FROM candidates
      WHERE queue.id = candidates.id
      RETURNING queue.id, queue.message_id, queue.account_id, queue.user_id, queue.connection_id,
                queue.transport, queue.needs_body, queue.needs_headers, queue.dispatch_state`,
    [limit, owner, LEASE_SECONDS],
  );
  return result.rows;
}

async function processDeferred(row: DeferredRow, owner: string): Promise<'applied' | 'retried' | 'discarded'> {
  const source = await query<{
    id: string; provider_message_id: string | null; body_text: string | null; parsed_headers: unknown;
    parsed_headers_complete: boolean; folder: string; is_deleted: boolean;
  }>(
    `SELECT m.id, m.provider_message_id, m.body_text, m.parsed_headers, m.parsed_headers_complete, m.folder, m.is_deleted
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
       JOIN provider_connections pc ON pc.id = a.provider_connection_id
      WHERE m.id = $1 AND m.account_id = $2
        AND a.user_id = $3 AND a.provider_connection_id = $4
        AND pc.user_id = $3 AND pc.id = $4 AND pc.status = 'active'`,
    [row.message_id, row.account_id, row.user_id, row.connection_id],
  );
  const message = source.rows[0];
  if (!message || message.folder !== 'INBOX' || message.is_deleted || !message.provider_message_id) {
    await query('DELETE FROM provider_rule_deferred_messages WHERE id = $1 AND lease_owner = $2', [row.id, owner]);
    return 'discarded';
  }

  const bodyMissing = row.needs_body && message.body_text === null;
  const headersMissing = row.needs_headers && !message.parsed_headers_complete;
  if (bodyMissing || headersMissing) {
    try {
      let bodyText: string | null = null;
      let headers: Record<string, string> | null = null;
      if (row.transport === 'gmail_api') {
        const api = { userId: row.user_id, connectionId: row.connection_id, config: googleConfigFromEnv(), owner };
        if (bodyMissing) {
          const content = await fetchGmailMessageContent(api, message.provider_message_id);
          bodyText = content.text ?? (content.html ? extractHtmlTextForRules(content.html) : null);
        }
        if (headersMissing) {
          const rawHeaders = await fetchGmailMessageHeaders(api, message.provider_message_id);
          if (!rawHeaders.trim()) return await retryRead(row, owner, 'provider returned no readable headers').then(() => 'retried');
          headers = parseHeadersInput(rawHeaders);
          if (Object.keys(headers).length === 0) return await retryRead(row, owner, 'provider returned no parseable headers').then(() => 'retried');
        }
      } else {
        const api = { userId: row.user_id, connectionId: row.connection_id, config: microsoftConfigFromEnv(), owner };
        if (bodyMissing) {
          const content = await fetchGraphMessageBody(api, message.provider_message_id);
          bodyText = content ? (content.contentType === 'html' ? extractHtmlTextForRules(content.content) : content.content) : null;
        }
        if (headersMissing) {
          const rawHeaders = await fetchGraphMessageHeaders(api, message.provider_message_id);
          if (!rawHeaders.trim()) return await retryRead(row, owner, 'provider returned no readable headers').then(() => 'retried');
          headers = parseHeadersInput(rawHeaders);
          if (Object.keys(headers).length === 0) return await retryRead(row, owner, 'provider returned no parseable headers').then(() => 'retried');
        }
      }
      // `null` means the provider did not give us a body. An empty string is a complete,
      // known body (for example an attachment-only message) and must be evaluated as such.
      if (bodyMissing && bodyText === null) return await retryRead(row, owner, 'provider returned no readable body').then(() => 'retried');
      await query(
        `UPDATE messages
            SET body_text = COALESCE(body_text, $2),
                parsed_headers = CASE WHEN $3::jsonb IS NULL THEN parsed_headers ELSE $3::jsonb END,
                parsed_headers_complete = CASE WHEN $3::jsonb IS NULL THEN parsed_headers_complete ELSE true END
          WHERE id = $1`,
        [message.id, bodyText, headers === null ? null : JSON.stringify(headers)],
      );
    } catch (caught) {
      return await retryRead(row, owner, caught instanceof Error ? caught.message : String(caught)).then(() => 'retried');
    }
  }

  // Keep the job while handing work to the existing action journals. A restart before
  // `beforeRuleAction` is called reclaims this dispatching row; once that callback
  // records an action boundary, an expired lease is parked as outcome_unknown rather
  // than replaying an externally visible provider action.
  const dispatching = await query(
    `UPDATE provider_rule_deferred_messages
        SET dispatch_state = 'dispatching', updated_at = NOW()
      WHERE id = $1 AND lease_owner = $2 AND action_started_at IS NULL`,
    [row.id, owner],
  );
  if ((dispatching.rowCount ?? 0) !== 1) return 'discarded';
  const { applyIngestRulesToRows } = await import('./providerIngestRules.js');
  let actionRefused = false;
  await applyIngestRulesToRows({
    userId: row.user_id,
    connectionId: row.connection_id,
    account: { id: row.account_id, user_id: row.user_id, mail_transport: row.transport, provider_connection_id: row.connection_id },
    folder: 'INBOX', rowIds: [row.message_id], providerName: row.transport === 'gmail_api' ? 'Gmail' : 'Microsoft Graph',
    skipDeferral: true,
    beforeRuleAction: async ({ messageId, ruleId }) => {
      // This is the final ownership/eligibility check, immediately before the rule
      // engine delegates to the transport's own mutation/forward journal.
      const marked = await query(
        `UPDATE provider_rule_deferred_messages q
            SET action_started_at = COALESCE(action_started_at, NOW()),
                action_rule_id = COALESCE(action_rule_id, $3::uuid), updated_at = NOW()
          WHERE q.id = $1 AND q.lease_owner = $2 AND q.dispatch_state = 'dispatching'
            AND EXISTS (
              SELECT 1 FROM messages m
              JOIN email_accounts a ON a.id = m.account_id
              JOIN provider_connections pc ON pc.id = a.provider_connection_id
               WHERE m.id = $4 AND m.account_id = q.account_id AND m.folder = 'INBOX'
                 AND m.is_deleted = false AND a.user_id = q.user_id
                 AND a.provider_connection_id = q.connection_id
                 AND pc.user_id = q.user_id AND pc.id = q.connection_id AND pc.status = 'active'
            )`,
        [row.id, owner, ruleId, messageId],
      );
      const allowed = (marked.rowCount ?? 0) === 1;
      if (!allowed) actionRefused = true;
      return allowed;
    },
  });
  const completed = await query(
    `UPDATE provider_rule_deferred_messages
        SET dispatch_state = $3, lease_owner = NULL, lease_expires_at = NULL,
            outcome_note = $4, updated_at = NOW()
      WHERE id = $1 AND lease_owner = $2`,
    [row.id, owner, actionRefused ? 'refused' : 'completed', actionRefused ? 'message or account no longer eligible for rule action' : 'rule evaluation completed'],
  );
  return (completed.rowCount ?? 0) === 1 ? 'applied' : 'discarded';
}

/** Drain bounded native-rule read deferrals. It retries only provider reads, never actions. */
export async function drainProviderRuleDeferrals(options: { limit?: number; owner?: string } = {}): Promise<{ applied: number; retried: number; discarded: number }> {
  const owner = options.owner ?? `provider-rule-deferrals:${process.pid}:${Date.now()}`;
  const rows = await claim(options.limit ?? 25, owner);
  // The process may have died after crossing an action journal boundary. Preserve a
  // visible unresolved record; automatic retry would turn an unknown provider outcome
  // into a duplicate move/delete/forward. Do this after claiming so a recovery sweep
  // cannot race a new claim for a still-retryable pre-action dispatch.
  await query(
    `UPDATE provider_rule_deferred_messages
        SET dispatch_state = 'outcome_unknown', lease_owner = NULL, lease_expires_at = NULL,
            outcome_note = 'worker lease expired after dispatch to rule action journal', updated_at = NOW()
      WHERE dispatch_state = 'dispatching' AND action_started_at IS NOT NULL
        AND lease_expires_at < NOW()`,
  );
  const result = { applied: 0, retried: 0, discarded: 0 };
  for (const row of rows) {
    const outcome = await processDeferred(row, owner);
    result[outcome]++;
  }
  return result;
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerRunning = false;

/** Start the bounded, single-flight reader; action retries remain deliberately unsupported. */
export function startProviderRuleDeferredWorker(): void {
  if (schedulerTimer) return;
  const configuredInterval = Number(process.env.PROVIDER_RULE_DEFERRED_INTERVAL_MS ?? 60_000);
  const intervalMs = Number.isFinite(configuredInterval) ? Math.max(1_000, configuredInterval) : 60_000;
  const tick = async () => {
    if (schedulerRunning) return;
    schedulerRunning = true;
    try {
      await drainProviderRuleDeferrals();
    } catch (caught) {
      console.warn('Provider rule deferred worker failed:', caught instanceof Error ? caught.message : caught);
    } finally {
      schedulerRunning = false;
    }
  };
  void tick();
  schedulerTimer = setInterval(() => { void tick(); }, intervalMs);
}

export function stopProviderRuleDeferredWorker(): void {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
  schedulerRunning = false;
}
