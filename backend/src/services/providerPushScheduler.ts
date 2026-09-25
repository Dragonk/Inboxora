import { query } from './db.js';
import { providerIntegrationsEnabled, readProviderSwitches } from './providerSwitches.js';
import { providerPushEnabled, renewAheadMinutes } from './providerPushConfig.js';
import {
  listSubscriptionsDueForRenewal,
  markSubscriptionsRemoved,
  recordSubscriptionFailure,
  type ProviderPushSubscription,
} from './providerPushSubscriptions.js';
import {
  createGraphSubscription,
  ensureGraphSubscriptions,
  recordGraphRenewalFailure,
  renewGraphSubscription,
} from './providerPushMicrosoft.js';
import {
  ensureGoogleSubscriptions,
  gmailPushAvailable,
  recordGoogleRenewalFailure,
  renewCalendarChannel,
  renewGmailWatch,
} from './providerPushGoogle.js';

/**
 * The renewal sweep.
 *
 * Both providers expire the things Inboxora registers: a Graph subscription in about three days, a Gmail
 * watch within seven, a Calendar channel within a week. The sweep renews them **before** they lapse, with a
 * per-provider safety margin, and treats a subscription the provider no longer knows as something to
 * recreate rather than to fail on.
 *
 * Three properties matter more than speed here:
 *
 * - **no duplicates** — renewal returns the same row and a recreate goes through the live-scope unique
 *   index, so a retry cannot leave two subscriptions being delivered (or two renewals being paid for);
 * - **no storm** — a failure sets a backoff with jitter; an unreachable provider is retried with a widening
 *   gap, and a disabled installation does not renew at all;
 * - **polling is untouched** — nothing here can stop the schedule, and if it never runs the mailboxes are
 *   still synchronised, just with the polling latency push exists to remove.
 */

const DEFAULT_SWEEP_MS = 10 * 60_000;

export function pushRenewSweepMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PROVIDER_PUSH_SWEEP_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SWEEP_MS;
  return Math.max(60_000, Math.min(60 * 60_000, Math.floor(raw)));
}

/** Spread a pass's own start, so a fleet of installations does not renew in lockstep. */
export function renewalJitterMs(random: () => number = Math.random): number {
  return Math.floor(random() * 60_000);
}

export interface PushRenewalSummary {
  considered: number;
  created: number;
  renewed: number;
  recreated: number;
  failed: number;
  skipped: number;
}

/** The remote calendar id a channel is opened against, read from the collection it belongs to. */
async function remoteCalendarIdForCollection(collectionId: string): Promise<string | null> {
  const result = await query<{ remote_id: string | null }>(
    'SELECT remote_id FROM integration_collections WHERE id = $1',
    [collectionId],
  );
  return result.rows[0]?.remote_id ?? null;
}

/** A subscription the provider no longer has must be recreated, not renewed for ever. */
export function shouldRecreate(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const status = Number((error as { status?: number } | null)?.status);
  return code === 'RESOURCE_NOT_FOUND' || status === 404;
}

/**
 * Bootstrap the missing Microsoft mail subscriptions of already-connected native
 * Graph mailboxes.
 *
 * Push used to be created only during explicit setup paths. Enabling
 * PROVIDER_PUSH_ENABLED on an existing installation therefore left all existing
 * Microsoft mailboxes on polling forever. The renewal scheduler is the natural
 * repair point: it already runs only when push is enabled, and
 * ensureGraphSubscriptions is idempotent for an existing live subscription.
 */
async function bootstrapMicrosoftMailPush(env: NodeJS.ProcessEnv): Promise<{ created: number; failed: number }> {
  const switches = await readProviderSwitches('microsoft');
  if (!switches.enabled || !switches.apiEnabled) return { created: 0, failed: 0 };

  const targets = await query<{ user_id: string; connection_id: string }>(
    `SELECT DISTINCT pc.user_id, pc.id AS connection_id
       FROM provider_connections pc
       JOIN email_accounts a
         ON a.provider_connection_id = pc.id
        AND a.user_id = pc.user_id
      WHERE pc.provider = 'microsoft'
        AND pc.status = 'active'
        AND a.enabled = true
        AND a.mail_transport = 'microsoft_graph'
        AND NOT EXISTS (
          SELECT 1
            FROM provider_push_subscriptions pps
           WHERE pps.provider_connection_id = pc.id
             AND pps.provider = 'microsoft'
             AND pps.resource_type = 'mail'
             AND pps.collection_id IS NULL
             AND pps.status = 'active'
             AND pps.expires_at > NOW() + INTERVAL '1 minute'
        )
      ORDER BY pc.id
      LIMIT 50`,
  );

  let created = 0;
  let failed = 0;

  for (const target of targets.rows) {
    try {
      const result = await ensureGraphSubscriptions({
        userId: target.user_id,
        connectionId: target.connection_id,
        resourceTypes: ['mail'],
        env,
      });
      created += result.created.length;
      failed += result.failed.length;
    } catch (error) {
      failed += 1;
      console.warn(
        `Microsoft mail push bootstrap failed for connection ${target.connection_id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return { created, failed };
}

/**
 * Bootstrap Gmail watches for existing Google-native mailboxes.
 *
 * Connections that predate PROVIDER_PUSH_ENABLED must not remain permanently on
 * polling. Only connections without a healthy live mail watch are selected, so
 * bounded batches advance naturally on later sweeps. Gmail push is attempted
 * only when the required Pub/Sub configuration is available.
 */
async function bootstrapGoogleMailPush(env: NodeJS.ProcessEnv): Promise<{ created: number; failed: number }> {
  const switches = await readProviderSwitches('google');
  if (!switches.enabled || !switches.apiEnabled) return { created: 0, failed: 0 };
  if (!gmailPushAvailable(env).available) return { created: 0, failed: 0 };

  const targets = await query<{ user_id: string; connection_id: string }>(
    `SELECT DISTINCT pc.user_id, pc.id AS connection_id
       FROM provider_connections pc
       JOIN email_accounts a
         ON a.provider_connection_id = pc.id
        AND a.user_id = pc.user_id
      WHERE pc.provider = 'google'
        AND pc.status = 'active'
        AND a.enabled = true
        AND a.mail_transport = 'gmail_api'
        AND NOT EXISTS (
          SELECT 1
            FROM provider_push_subscriptions pps
           WHERE pps.provider_connection_id = pc.id
             AND pps.provider = 'google'
             AND pps.resource_type = 'mail'
             AND pps.collection_id IS NULL
             AND pps.status = 'active'
             AND pps.expires_at > NOW() + INTERVAL '1 minute'
        )
      ORDER BY pc.id
      LIMIT 50`,
  );

  let created = 0;
  let failed = 0;

  for (const target of targets.rows) {
    try {
      const result = await ensureGoogleSubscriptions({
        userId: target.user_id,
        connectionId: target.connection_id,
        calendars: [],
        includeMail: true,
        env,
      });
      created += result.created.filter(resource => resource === 'mail').length;
      failed += result.failed.length;
    } catch (error) {
      failed += 1;
      console.warn(
        `Gmail push bootstrap failed for connection ${target.connection_id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return { created, failed };
}

export async function runProviderPushRenewals(env: NodeJS.ProcessEnv = process.env): Promise<PushRenewalSummary> {
  const summary: PushRenewalSummary = { considered: 0, created: 0, renewed: 0, recreated: 0, failed: 0, skipped: 0 };
  if (!providerPushEnabled(env)) return summary;
  // A disabled provider layer means no provider calls at all, renewals included.
  if (!providerIntegrationsEnabled()) return summary;

  // Existing installations may have no subscription row at all because push can be
  // enabled after the Microsoft account was already connected.
  const microsoftBootstrap = await bootstrapMicrosoftMailPush(env);
  summary.created += microsoftBootstrap.created;
  summary.failed += microsoftBootstrap.failed;

  const googleBootstrap = await bootstrapGoogleMailPush(env);
  summary.created += googleBootstrap.created;
  summary.failed += googleBootstrap.failed;

  const due = await listSubscriptionsDueForRenewal({
    aheadMinutes: renewAheadMinutes(env),
    limit: 50,
  });
  summary.considered = due.length;

  for (const subscription of due) {
    if (subscription.status === 'disabled') {
      summary.skipped += 1;
      continue;
    }
    // A provider switched off for this installation must not be called at all: its subscriptions are marked
    // disabled in place instead of being renewed, so turning the provider back on is what resumes them.
    const switches = await readProviderSwitches(subscription.provider);
    if (!switches.enabled || !switches.apiEnabled) {
      await markSubscriptionsRemoved({ subscriptionIds: [subscription.id], status: 'disabled' });
      summary.skipped += 1;
      continue;
    }
    try {
      if (subscription.provider === 'microsoft') {
        const outcome = await renewSubscription(subscription);
        if (outcome === 'recreated') summary.recreated += 1;
        else summary.renewed += 1;
      } else if (subscription.resource_type === 'mail') {
        await renewGmailWatch({
          userId: subscription.user_id,
          connectionId: subscription.provider_connection_id,
          subscription,
        });
        summary.renewed += 1;
      } else if (subscription.resource_type === 'calendar') {
        const remoteCalendarId = subscription.collection_id
          ? await remoteCalendarIdForCollection(subscription.collection_id)
          : null;
        if (!remoteCalendarId) {
          // The collection is gone; the channel has nothing left to follow.
          await markSubscriptionsRemoved({ subscriptionIds: [subscription.id] });
          summary.skipped += 1;
          continue;
        }
        await renewCalendarChannel({
          userId: subscription.user_id,
          connectionId: subscription.provider_connection_id,
          subscription,
          remoteCalendarId,
        });
        summary.renewed += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (error) {
      if (shouldRecreate(error) && subscription.provider === 'microsoft') {
        try {
          await createGraphSubscription({
            userId: subscription.user_id,
            connectionId: subscription.provider_connection_id,
            resourceType: subscription.resource_type,
          });
          await markSubscriptionsRemoved({ subscriptionIds: [subscription.id] });
          summary.recreated += 1;
          continue;
        } catch (recreateError) {
          await recordGraphRenewalFailure({ subscription, error: recreateError });
          summary.failed += 1;
          continue;
        }
      }
      if (subscription.provider === 'microsoft') await recordGraphRenewalFailure({ subscription, error });
      else await recordGoogleRenewalFailure({ subscription, error });
      summary.failed += 1;
    }
  }
  return summary;
}

/**
 * Renew one Microsoft subscription, recreating it when Graph has forgotten it.
 *
 * A subscription Graph answers `404` for is not a failure to retry: the expiry it reported no longer exists,
 * so a fresh one is registered for the same scope and the old row becomes a tombstone.
 */
async function renewSubscription(subscription: ProviderPushSubscription): Promise<'renewed' | 'recreated'> {
  try {
    await renewGraphSubscription({
      userId: subscription.user_id,
      connectionId: subscription.provider_connection_id,
      subscription,
    });
    return 'renewed';
  } catch (error) {
    if (!shouldRecreate(error)) throw error;
    await createGraphSubscription({
      userId: subscription.user_id,
      connectionId: subscription.provider_connection_id,
      resourceType: subscription.resource_type,
    });
    await markSubscriptionsRemoved({ subscriptionIds: [subscription.id] });
    return 'recreated';
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let firstPass: ReturnType<typeof setTimeout> | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const summary = await runProviderPushRenewals();
    if (summary.created || summary.renewed || summary.recreated || summary.failed) {
      console.log(
        `Provider push renewals: considered=${summary.considered} created=${summary.created} renewed=${summary.renewed} `
        + `recreated=${summary.recreated} failed=${summary.failed} skipped=${summary.skipped}`,
      );
    }
  } catch (error) {
    console.warn('Provider push renewal pass failed:', error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
}

export function startProviderPushScheduler(env: NodeJS.ProcessEnv = process.env): void {
  stopProviderPushScheduler();
  if (!providerPushEnabled(env)) return;
  const sweepMs = pushRenewSweepMs(env);
  // The first pass waits a jittered minute: a restart must not renew every subscription at once, and it must
  // not compete with start-up either.
  firstPass = setTimeout(() => { void tick(); }, 30_000 + renewalJitterMs());
  if (typeof firstPass.unref === 'function') firstPass.unref();
  timer = setInterval(() => { void tick(); }, sweepMs);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopProviderPushScheduler(): void {
  if (firstPass) clearTimeout(firstPass);
  firstPass = null;
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}

/** Record a renewal failure without a subscription row (used by the admin-triggered setup path). */
export async function recordOrphanRenewalFailure(code: string): Promise<void> {
  console.warn(`Provider push renewal failed: ${code}`);
}

/** Exported for the diagnostics endpoint: how a failing renewal is described. */
export { recordSubscriptionFailure };
