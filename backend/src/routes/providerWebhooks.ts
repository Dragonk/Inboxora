import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { query } from '../services/db.js';
import {
  findSubscriptionByProviderId,
  findLiveSubscription,
  pushSecretMatches,
  recordSubscriptionNotification,
  type ProviderPushSubscription,
} from '../services/providerPushSubscriptions.js';
import { enqueueProviderSyncHint } from '../services/providerSyncHints.js';
import { consume } from '../services/rateLimiter.js';
import { triggerProviderSyncHintDrain } from '../services/providerSyncHintWorker.js';
import { googlePubSubVerificationToken, providerPushEnabled } from '../services/providerPushConfig.js';
import {
  createGraphSubscription,
  GRAPH_WEBHOOK_PATH,
  renewGraphSubscription,
  microsoftPushAvailable,
} from '../services/providerPushMicrosoft.js';
import { GOOGLE_CALENDAR_WEBHOOK_PATH, GMAIL_WEBHOOK_PATH } from '../services/providerPushGoogle.js';

/**
 * The inbound half of push-assisted synchronisation.
 *
 * These endpoints are public by necessity — a provider calls them from the internet — so each one
 * authenticates the provider with its own mechanism and nothing else:
 *
 * - Microsoft: the `clientState` on the notification, compared constant-time against the stored hash of the
 *   subscription it names. Graph's creation-time validation handshake is answered here too.
 * - Google Calendar: the `X-Goog-Channel-Token` against the stored hash of that channel, plus the resource
 *   id the channel was opened for.
 * - Gmail: the Pub/Sub push token the administrator configured, compared against the stored hash of the
 *   watch's token, with the mailbox resolved from the message payload through the local connections.
 *
 * None of them reads state out of the payload. A notification names a resource; the existing delta, history
 * or sync-token sync decides what changed. A notification that cannot be authenticated, or that names
 * something Inboxora does not know, is rejected without saying which of the two it was.
 */

/**
 * A payload larger than this is not a notification.
 *
 * A Graph notification batch is a few kilobytes and a Pub/Sub message is smaller still, so the bound is
 * generous while still refusing anything that looks like an attempt to make Inboxora parse a document.
 */
export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
/** Graph caps a batch at 1000 notifications; a body claiming more is not one Inboxora will process. */
export const WEBHOOK_MAX_NOTIFICATIONS = 100;

const router = Router();

/**
 * A bounded JSON body parser for the webhook mounts.
 *
 * It replaces the global parser's verdict for these paths only: a body over the limit, or one that is not
 * JSON at all, is a `400` (or `413`) with a small JSON answer and no detail about what was expected.
 */
function boundedJsonBody(req: Request, res: Response, next: () => void): void {
  const declared = Number(req.get('content-length'));
  if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BODY_BYTES) {
    res.status(413).json({ error: 'Payload too large' });
    return;
  }
  const contentType = String(req.get('content-type') ?? '').toLowerCase();
  // A Graph notification is JSON; the validation handshake POSTs with no body at all.
  if (req.method === 'POST' && contentType && !contentType.includes('json') && !contentType.includes('text/plain')) {
    res.status(415).json({ error: 'Unsupported content type' });
    return;
  }
  next();
}

router.use(boundedJsonBody);

/**
 * A per-source rate limit, in front of everything else.
 *
 * The endpoints are public, so an unauthenticated flood has to be cheap to refuse. The limit is generous —
 * a busy mailbox can legitimately produce a burst, and the hints coalesce anyway — and a Redis outage falls
 * back to the in-process counter the limiter already carries, so a webhook is never rejected merely because
 * the limiter's own store is unavailable.
 */
const WEBHOOK_RATE_LIMIT = 600;
const WEBHOOK_RATE_WINDOW_MS = 60_000;

router.use(async (req: Request, res: Response, next: () => void) => {
  const source = req.ip || req.socket?.remoteAddress || 'unknown';
  const outcome = await consume(`provider-webhook:${source}`, WEBHOOK_RATE_LIMIT, WEBHOOK_RATE_WINDOW_MS);
  if (outcome.limited) {
    res.setHeader('Retry-After', String(Math.ceil(outcome.resetMs / 1000)));
    res.status(429).json({ error: 'Too many requests' });
    return;
  }
  next();
});

/** Whether the installation may accept notifications at all. */
function pushDisabled(res: Response): boolean {
  if (providerPushEnabled()) return false;
  res.status(404).json({ error: 'Not found' });
  return true;
}

/** A rejection that never says whether the subscription or the secret was wrong. */
function rejectNotification(res: Response): void {
  res.status(202).json({ accepted: false });
}

interface GraphNotification {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  resourceData?: unknown;
  lifecycleEvent?: string;
  tenantId?: string;
  subscriptionExpirationDateTime?: string;
}

/**
 * Graph's creation-time validation: answer the token as plain text, exactly as sent, and nothing else.
 *
 * This happens before any authentication because Graph validates the URL while creating the subscription —
 * there is no subscription to look up yet. It carries no state, so echoing it is not an information leak.
 */
function handleValidationHandshake(req: Request, res: Response): boolean {
  const token = req.query.validationToken;
  if (typeof token !== 'string' || token === '') return false;
  res.status(200);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(token.slice(0, 4096));
  return true;
}

/**
 * A lifecycle event the subscription itself reported.
 *
 * `missed` is deliberately not a request to replay anything: it means notifications were dropped, so the
 * correct answer is a normal delta sync that reconciles from the cursor — which is what a hint does anyway.
 * `subscriptionRemoved` recreates the subscription and lets polling cover the gap. A `reauthorizationRequired`
 * that cannot renew against the current grant leaves the subscription failed: the account becomes actionable
 * in the UI, and polling keeps the mailbox current rather than the renewal loop hammering a dead grant.
 */
async function handleGraphLifecycle(subscription: ProviderPushSubscription, lifecycleEvent: string): Promise<void> {
  console.log(`Graph lifecycle notification for subscription ${subscription.id}: ${lifecycleEvent}`);
  if (lifecycleEvent === 'missed') {
    await enqueueProviderSyncHint({
      userId: subscription.user_id,
      connectionId: subscription.provider_connection_id,
      provider: 'microsoft',
      resourceType: subscription.resource_type,
    });
    triggerProviderSyncHintDrain();
    return;
  }
  if (lifecycleEvent === 'subscriptionRemoved') {
    try {
      await createGraphSubscription({
        userId: subscription.user_id,
        connectionId: subscription.provider_connection_id,
        resourceType: subscription.resource_type,
      });
      // The replaced row is a tombstone; the new one is already the live row for this scope.
      await enqueueProviderSyncHint({
        userId: subscription.user_id,
        connectionId: subscription.provider_connection_id,
        provider: 'microsoft',
        resourceType: subscription.resource_type,
      });
      triggerProviderSyncHintDrain();
    } catch (error) {
      console.warn(`Graph subscription ${subscription.id} could not be recreated:`, error instanceof Error ? error.message : error);
    }
    return;
  }
  if (lifecycleEvent === 'reauthorizationRequired') {
    try {
      await renewGraphSubscription({
        userId: subscription.user_id,
        connectionId: subscription.provider_connection_id,
        subscription,
      });
    } catch (error) {
      console.warn(`Graph subscription ${subscription.id} needs reauthorization:`, error instanceof Error ? error.message : error);
    }
  }
}

router.post('/microsoft', async (req: Request, res: Response) => {
  if (pushDisabled(res)) return;
  if (handleValidationHandshake(req, res)) return;

  const body = (req.body ?? {}) as { value?: GraphNotification[] };
  const notifications = Array.isArray(body.value) ? body.value : [];
  if (!notifications.length || notifications.length > WEBHOOK_MAX_NOTIFICATIONS) return rejectNotification(res);

  let accepted = 0;
  for (const notification of notifications) {
    const subscriptionId = typeof notification.subscriptionId === 'string' ? notification.subscriptionId : '';
    if (!subscriptionId) continue;
    // The subscription id is the only identifier from the payload that is used, and only to find the local
    // row. Everything else — the resource path, the tenant, any mailbox claim — is ignored.
    const subscription = await findSubscriptionByProviderId('microsoft', subscriptionId);
    if (!subscription) continue;
    if (!pushSecretMatches(notification.clientState, await secretHashFor(subscription.id))) continue;

    await recordSubscriptionNotification(subscription.id);
    accepted += 1;

    const lifecycleEvent = typeof notification.lifecycleEvent === 'string' ? notification.lifecycleEvent : '';
    if (lifecycleEvent) {
      await handleGraphLifecycle(subscription, lifecycleEvent);
      continue;
    }
    await enqueueProviderSyncHint({
      userId: subscription.user_id,
      connectionId: subscription.provider_connection_id,
      provider: 'microsoft',
      resourceType: subscription.resource_type,
    });
  }

  if (accepted) triggerProviderSyncHintDrain();
  // Graph reads only the status: a 2xx means "delivered", and answering 4xx would make it retry a
  // notification Inboxora deliberately ignored (and reveal which check refused it).
  res.status(202).json({ accepted: accepted > 0, count: accepted });
});

/** The stored secret hash for a subscription, read here so the hashes never travel with the row. */
async function secretHashFor(subscriptionId: string): Promise<string | null> {
  const result = await query<{ secret_hash: string | null }>(
    'SELECT secret_hash FROM provider_push_subscriptions WHERE id = $1',
    [subscriptionId],
  );
  return result.rows[0]?.secret_hash ?? null;
}

router.post('/google-calendar', async (req: Request, res: Response) => {
  if (pushDisabled(res)) return;

  const channelId = String(req.get('x-goog-channel-id') ?? '');
  const resourceId = String(req.get('x-goog-resource-id') ?? '');
  const channelToken = String(req.get('x-goog-channel-token') ?? '');
  const state = String(req.get('x-goog-resource-state') ?? '');
  if (!channelId || !resourceId) return rejectNotification(res);
  // `sync` is the channel's opening handshake: it proves the address works and carries no change.
  if (state === 'sync') {
    res.status(200).json({ accepted: true, state });
    return;
  }

  const subscription = await findSubscriptionByProviderId('google', channelId);
  if (!subscription || subscription.resource_type !== 'calendar') return rejectNotification(res);
  // Both the token and the resource the channel was opened for have to match: a token alone would let a
  // channel for another calendar (or another user) drive this one.
  if (!pushSecretMatches(channelToken, await secretHashFor(subscription.id))) return rejectNotification(res);
  if (subscription.remote_resource_id && subscription.remote_resource_id !== resourceId) return rejectNotification(res);

  await recordSubscriptionNotification(subscription.id);
  await enqueueProviderSyncHint({
    userId: subscription.user_id,
    connectionId: subscription.provider_connection_id,
    provider: 'google',
    resourceType: 'calendar',
    collectionId: subscription.collection_id,
  });
  triggerProviderSyncHintDrain();
  res.status(200).json({ accepted: true });
});

interface PubSubEnvelope {
  message?: { data?: string; messageId?: string; publishTime?: string };
  subscription?: string;
}

/**
 * A Gmail notification, delivered by Cloud Pub/Sub.
 *
 * There is no per-mailbox channel here, so the mailbox comes from the message's `emailAddress` — mapped
 * through the local Google connections rather than trusted as an account id — and the message's `historyId`
 * is deliberately **not** used as a cursor: the history sync owns its own baseline, and adopting the
 * notification's number is exactly how a change would be skipped.
 */
router.post('/gmail', async (req: Request, res: Response) => {
  if (pushDisabled(res)) return;

  const token = googlePubSubVerificationToken();
  const presented = String(req.get('x-inboxora-pubsub-token') ?? req.query.token ?? '');
  if (!token || !presented || !pushSecretMatches(presented, pushTokenHash())) return rejectNotification(res);

  const envelope = (req.body ?? {}) as PubSubEnvelope;
  const data = envelope.message?.data;
  if (typeof data !== 'string' || !data) return rejectNotification(res);
  let decoded: { emailAddress?: string; historyId?: string | number };
  try {
    decoded = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as { emailAddress?: string; historyId?: string | number };
  } catch {
    return rejectNotification(res);
  }
  const mailbox = typeof decoded.emailAddress === 'string' ? decoded.emailAddress.trim().toLowerCase() : '';
  if (!mailbox) return rejectNotification(res);

  const connection = await query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM provider_connections
      WHERE provider = 'google' AND status = 'active' AND lower(COALESCE(provider_user_id, '')) = $1
      ORDER BY created_at ASC`,
    [mailbox],
  );
  const target = connection.rows[0];
  if (!target) return rejectNotification(res);
  const subscription = await findLiveSubscription({ connectionId: target.id, resourceType: 'mail' });
  if (!subscription) return rejectNotification(res);

  await recordSubscriptionNotification(subscription.id);
  await enqueueProviderSyncHint({
    userId: target.user_id,
    connectionId: target.id,
    provider: 'google',
    resourceType: 'mail',
  });
  triggerProviderSyncHintDrain();
  res.status(200).json({ accepted: true });
});

/** The stored hash of the configured Pub/Sub token; the plaintext is only ever in the environment. */
function pushTokenHash(): string {
  const token = googlePubSubVerificationToken();
  if (!token) return '';
  // The token is compared through the same hashing as a subscription secret, so the comparison stays
  // constant-time and no plaintext is retained in this module.
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The absolute paths the provider cards and the diagnostics report. */
export const WEBHOOK_PATHS = {
  microsoft: GRAPH_WEBHOOK_PATH,
  gmail: GMAIL_WEBHOOK_PATH,
  googleCalendar: GOOGLE_CALENDAR_WEBHOOK_PATH,
};

/** Kept for the setup path: whether Microsoft push can be offered at all. */
export { microsoftPushAvailable };

export default router;
