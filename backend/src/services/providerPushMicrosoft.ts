import { graphDelete, graphPatch, graphPost, type GraphApiOptions } from './providers/microsoft/graphApiClient.js';
import { GraphApiError } from './providers/microsoft/graphApiClient.js';
import type { FetchLike } from './providerAuthService.js';
import {
  hashPushSecret,
  listSubscriptionsForConnection,
  markSubscriptionsRemoved,
  newPushSecret,
  recordSubscriptionFailure,
  recordSubscriptionRenewed,
  upsertPushSubscription,
  type ProviderPushResourceType,
  type ProviderPushSubscription,
} from './providerPushSubscriptions.js';
import { providerPushEnabled, publicWebhookUrl } from './providerPushConfig.js';

/**
 * Microsoft Graph change notifications for Outlook resources: messages, events and personal contacts.
 *
 * Graph is told where to call and how to prove itself, and it answers with a subscription id and an expiry.
 * The mapping between Inboxora's resource types and Graph's resource paths is fixed here:
 *
 * - `mail` → `/me/messages`
 * - `calendar` → `/me/events`
 * - `contacts` → `/me/contacts`
 *
 * All three are delegated (`/me`) because Inboxora reads the mailbox the user authorized. A notification
 * never carries state Inboxora trusts: it names the subscription, and the existing delta sync decides what
 * changed.
 */

/** The Graph resource path per resource type. Personal contacts only, as the Contacts grant allows. */
export const GRAPH_RESOURCE_PATHS: Record<ProviderPushResourceType, string> = {
  mail: '/me/messages',
  calendar: '/me/events',
  contacts: '/me/contacts',
};

export const GRAPH_WEBHOOK_PATH = '/api/provider-webhooks/microsoft';

/**
 * Outlook subscriptions may live at most ~3 days (4230 minutes). 4200 minutes leaves margin, and the
 * renewal sweep runs far more often than that anyway: the lifetime bounds how bad a total outage can get,
 * it is not the renewal cadence.
 */
export const GRAPH_SUBSCRIPTION_MINUTES = 4200;

export interface GraphSubscription {
  id: string;
  resource: string;
  changeType: string;
  expirationDateTime: string;
  clientState?: string;
}

/** Whether Graph push is available: the operator enabled it and a public URL can be derived. */
export function microsoftPushAvailable(env: NodeJS.ProcessEnv = process.env): { available: boolean; notificationUrl: string | null; reason: string | null } {
  if (!providerPushEnabled(env)) return { available: false, notificationUrl: null, reason: 'PROVIDER_PUSH_DISABLED' };
  const notificationUrl = publicWebhookUrl(GRAPH_WEBHOOK_PATH, env);
  if (!notificationUrl) return { available: false, notificationUrl: null, reason: 'PUBLIC_URL_NOT_CONFIGURED' };
  return { available: true, notificationUrl, reason: null };
}

function apiOptions(input: { userId: string; connectionId: string; fetchImpl?: FetchLike }): GraphApiOptions {
  return {
    userId: input.userId,
    connectionId: input.connectionId,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  };
}

/**
 * Create (or recreate) one subscription.
 *
 * `clientState` is fresh random material on every create, and only its hash is stored: the inbound
 * notification carries the plaintext, and comparing it against the hash is the whole authentication of a
 * Graph webhook. The plaintext never reaches a log, an API response or the database.
 */
export async function createGraphSubscription(input: {
  userId: string;
  connectionId: string;
  resourceType: ProviderPushResourceType;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}): Promise<ProviderPushSubscription> {
  const availability = microsoftPushAvailable(input.env ?? process.env);
  if (!availability.available || !availability.notificationUrl) {
    throw new Error(`Microsoft push is not available: ${availability.reason}`);
  }
  const secret = newPushSecret();
  const body = {
    changeType: 'created,updated,deleted',
    notificationUrl: availability.notificationUrl,
    lifecycleNotificationUrl: availability.notificationUrl,
    resource: GRAPH_RESOURCE_PATHS[input.resourceType],
    expirationDateTime: new Date(Date.now() + GRAPH_SUBSCRIPTION_MINUTES * 60_000).toISOString(),
    clientState: secret,
    // `includeResourceData` stays off: Inboxora does not want message bodies in a webhook payload, and
    // without it Graph sends only identifiers, which is exactly the "hint, not state" contract.
  };
  const created = await graphPost<GraphSubscription>(apiOptions(input), '/subscriptions', body);
  if (!created?.id) throw new Error('Graph accepted the subscription request without returning an id');
  return upsertPushSubscription({
    userId: input.userId,
    connectionId: input.connectionId,
    provider: 'microsoft',
    resourceType: input.resourceType,
    providerSubscriptionId: created.id,
    providerResource: created.resource ?? GRAPH_RESOURCE_PATHS[input.resourceType],
    secret,
    secretKind: 'client_state',
    expiresAt: created.expirationDateTime ?? body.expirationDateTime,
  });
}

/**
 * Extend a subscription that already exists.
 *
 * The `clientState` is not re-sent: Graph keeps the one the subscription was created with, and a renew that
 * changed it would invalidate the notifications already in flight.
 */
export async function renewGraphSubscription(input: {
  userId: string;
  connectionId: string;
  subscription: ProviderPushSubscription;
  fetchImpl?: FetchLike;
}): Promise<ProviderPushSubscription> {
  const subscriptionId = input.subscription.provider_subscription_id;
  if (!subscriptionId) throw new Error('This subscription has no Graph id to renew');
  const expirationDateTime = new Date(Date.now() + GRAPH_SUBSCRIPTION_MINUTES * 60_000).toISOString();
  const renewed = await graphPatch<GraphSubscription>(
    apiOptions(input),
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { expirationDateTime },
  );
  await recordSubscriptionRenewed({
    id: input.subscription.id,
    expiresAt: renewed?.expirationDateTime ?? expirationDateTime,
  });
  return { ...input.subscription, status: 'active', expires_at: renewed?.expirationDateTime ?? expirationDateTime };
}

/** Remove a subscription at Graph. A subscription Graph no longer has is the end state the caller wanted. */
export async function removeGraphSubscription(input: {
  userId: string;
  connectionId: string;
  subscription: ProviderPushSubscription;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const subscriptionId = input.subscription.provider_subscription_id;
  if (!subscriptionId) return;
  try {
    await graphDelete(apiOptions(input), `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  } catch (error) {
    if (error instanceof GraphApiError && error.status === 404) return;
    throw error;
  }
}

/**
 * Bring one connection's subscriptions up to date, creating what is missing and recreating what expired.
 *
 * Idempotent: the live-scope unique index means a second call updates the row it already has rather than
 * creating a duplicate subscription at Graph, which is what keeps a retry from doubling the notification
 * volume (and the renewal work) for one mailbox.
 */
export async function ensureGraphSubscriptions(input: {
  userId: string;
  connectionId: string;
  resourceTypes: ProviderPushResourceType[];
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}): Promise<{ created: ProviderPushResourceType[]; failed: Array<{ resourceType: ProviderPushResourceType; code: string }> }> {
  const created: ProviderPushResourceType[] = [];
  const failed: Array<{ resourceType: ProviderPushResourceType; code: string }> = [];
  if (!microsoftPushAvailable(input.env ?? process.env).available) {
    return { created, failed: input.resourceTypes.map(resourceType => ({ resourceType, code: 'PUSH_UNAVAILABLE' })) };
  }
  const existing = await listSubscriptionsForConnection(input.connectionId);
  for (const resourceType of input.resourceTypes) {
    const live = existing.find(row => row.resource_type === resourceType && row.collection_id === null);
    if (live && live.status === 'active' && live.expires_at && new Date(live.expires_at).getTime() > Date.now() + 60_000) continue;
    try {
      await createGraphSubscription({
        userId: input.userId,
        connectionId: input.connectionId,
        resourceType,
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        ...(input.env ? { env: input.env } : {}),
      });
      created.push(resourceType);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code ?? 'SUBSCRIPTION_CREATE_FAILED';
      failed.push({ resourceType, code });
      console.warn(`Microsoft ${resourceType} subscription could not be created for connection ${input.connectionId}:`, error instanceof Error ? error.message : error);
    }
  }
  return { created, failed };
}

/** Stop every subscription of a connection at Graph, then mark them all removed locally regardless. */
export async function stopGraphSubscriptionsForConnection(input: {
  userId: string;
  connectionId: string;
  fetchImpl?: FetchLike;
}): Promise<{ attempted: number; failed: number }> {
  const subscriptions = await listSubscriptionsForConnection(input.connectionId);
  let failed = 0;
  for (const subscription of subscriptions) {
    try {
      await removeGraphSubscription({
        userId: input.userId,
        connectionId: input.connectionId,
        subscription,
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      });
    } catch (error) {
      failed += 1;
      // The local tombstone is what matters: an unreachable Graph must not leave a subscription here that a
      // later sweep would try to renew for an account that no longer exists.
      console.warn(`Microsoft subscription ${subscription.id} could not be removed at Graph:`, error instanceof Error ? error.message : error);
    }
  }
  await markSubscriptionsRemoved({ connectionId: input.connectionId });
  return { attempted: subscriptions.length, failed };
}

/** Record a failed renewal so the sweep backs off instead of retrying on every tick. */
export async function recordGraphRenewalFailure(input: {
  subscription: ProviderPushSubscription;
  error: unknown;
}): Promise<void> {
  const code = (input.error as { code?: string } | null)?.code ?? 'SUBSCRIPTION_RENEW_FAILED';
  const retryAfterSeconds = Number((input.error as { retryAfterSeconds?: number } | null)?.retryAfterSeconds);
  await recordSubscriptionFailure({
    id: input.subscription.id,
    code,
    status: code === 'RESOURCE_NOT_FOUND' ? 'expired' : 'failed',
    ...(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? { retryAfterSeconds } : {}),
  });
}

/** Exposed for tests: the stored hash of a secret, which is the only form that leaves this module. */
export { hashPushSecret };
