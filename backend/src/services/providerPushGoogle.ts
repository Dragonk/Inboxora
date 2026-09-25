import {
  googleApiFetch,
  googleApiVoid,
  type GoogleApiOptions,
} from './providers/google/googleApiClient.js';
import { GoogleApiError } from './providers/google/googleApiClient.js';
import { googleConfigFromEnv, type FetchLike } from './providerAuthService.js';
import { query } from './db.js';
import {
  findLiveSubscription,
  listSubscriptionsForConnection,
  markSubscriptionsRemoved,
  newPushSecret,
  recordSubscriptionFailure,
  recordSubscriptionRenewed,
  upsertPushSubscription,
  type ProviderPushSubscription,
} from './providerPushSubscriptions.js';
import {
  gmailPushConfigured,
  googlePubSubTopic,
  providerPushEnabled,
  publicWebhookUrl,
} from './providerPushConfig.js';

/**
 * Google's push mechanisms, which are two different things:
 *
 * **Gmail** uses `users.watch` plus Google Cloud Pub/Sub. The watch registers the mailbox against a topic;
 * Pub/Sub delivers a message to Inboxora's own HTTPS endpoint. There is no per-mailbox secret in the URL —
 * the endpoint is authenticated by a shared high-entropy token the administrator configured, and the
 * mailbox is resolved from the message's `emailAddress` through the local connections. A watch expires
 * after at most seven days, so it is renewed daily and long before it lapses.
 *
 * **Google Calendar** uses push channels: one `watch` per pulled calendar, each with its own channel id and
 * token, delivering `X-Goog-*` headers to the same endpoint family. The channel's expiration is stored, the
 * channel is renewed before it lapses, and the previous channel is stopped when it is replaced.
 *
 * Neither notification carries state Inboxora trusts: the existing history cursor (Gmail) and sync token
 * (Calendar) decide what actually changed.
 */

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
export const GOOGLE_CALENDAR_WEBHOOK_PATH = '/api/provider-webhooks/google-calendar';
export const GMAIL_WEBHOOK_PATH = '/api/provider-webhooks/gmail';

/**
 * Google recommends renewing a Gmail watch at least daily, and a watch never lasts longer than seven days.
 * A renewed watch also resets the history baseline, so renewing often is safe as well as required.
 */
export const GMAIL_WATCH_RENEW_MINUTES = 24 * 60;
/** Calendar channels are capped at a week; six days leaves a day of slack for a missed renewal. */
export const CALENDAR_CHANNEL_TTL_SECONDS = 6 * 24 * 3600;

export function googleCalendarPushAvailable(env: NodeJS.ProcessEnv = process.env): { available: boolean; address: string | null; reason: string | null } {
  if (!providerPushEnabled(env)) return { available: false, address: null, reason: 'PROVIDER_PUSH_DISABLED' };
  const address = publicWebhookUrl(GOOGLE_CALENDAR_WEBHOOK_PATH, env);
  if (!address) return { available: false, address: null, reason: 'PUBLIC_URL_NOT_CONFIGURED' };
  return { available: true, address, reason: null };
}

export function gmailPushAvailable(env: NodeJS.ProcessEnv = process.env): { available: boolean; reason: string | null } {
  if (!gmailPushConfigured(env)) {
    if (!providerPushEnabled(env)) return { available: false, reason: 'PROVIDER_PUSH_DISABLED' };
    if (!publicWebhookUrl(GMAIL_WEBHOOK_PATH, env)) return { available: false, reason: 'PUBLIC_URL_NOT_CONFIGURED' };
    if (!googlePubSubTopic(env)) return { available: false, reason: 'PUBSUB_TOPIC_NOT_CONFIGURED' };
    return { available: false, reason: 'PUBSUB_TOKEN_NOT_CONFIGURED' };
  }
  return { available: true, reason: null };
}

function apiOptions(input: { userId: string; connectionId: string; fetchImpl?: FetchLike }): GoogleApiOptions {
  return {
    userId: input.userId,
    connectionId: input.connectionId,
    config: googleConfigFromEnv(),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  };
}

interface GmailWatchResponse {
  historyId?: string;
  expiration?: string;
}

/**
 * Register (or refresh) the Gmail watch for a mailbox.
 *
 * Only `INBOX` is watched: that is the label every new message lands on, and a watch on every label would
 * multiply the notification volume without telling Inboxora anything the history cursor does not already
 * cover. The returned `historyId` is deliberately **not** stored as a cursor — the history sync owns its own
 * baseline, and overwriting it from a watch response is how a notification would skip changes.
 */
export async function startGmailWatch(input: {
  userId: string;
  connectionId: string;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}): Promise<ProviderPushSubscription> {
  const availability = gmailPushAvailable(input.env ?? process.env);
  const topic = googlePubSubTopic(input.env ?? process.env);
  if (!availability.available || !topic) throw new Error(`Gmail push is not available: ${availability.reason}`);
  const secret = newPushSecret();
  const response = await googleApiFetch<GmailWatchResponse>(apiOptions(input), `${GMAIL_BASE}/users/me/watch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topicName: topic, labelIds: ['INBOX'] }),
  });
  const expirationMs = Number(response?.expiration);
  const expiresAt = Number.isFinite(expirationMs) && expirationMs > 0
    ? new Date(expirationMs)
    : new Date(Date.now() + GMAIL_WATCH_RENEW_MINUTES * 60_000);
  return upsertPushSubscription({
    userId: input.userId,
    connectionId: input.connectionId,
    provider: 'google',
    resourceType: 'mail',
    providerSubscriptionId: 'gmail-watch',
    providerResource: topic,
    secret,
    secretKind: 'pubsub_token',
    expiresAt,
  });
}

/** Stop a Gmail watch. Google answers 404 for a mailbox that is no longer watched, which is the goal. */
export async function stopGmailWatch(input: {
  userId: string;
  connectionId: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  try {
    await googleApiVoid(apiOptions(input), `${GMAIL_BASE}/users/me/stop`, { method: 'POST' });
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 404) return;
    throw error;
  }
}

interface CalendarChannelResponse {
  id?: string;
  resourceId?: string;
  resourceUri?: string;
  expiration?: string;
}

/**
 * Open a push channel for one pulled calendar.
 *
 * The channel's `token` is the secret a notification presents; only its hash is stored. Re-registering is
 * idempotent at the local level through the live-scope row, and the caller stops the previous channel after
 * a successful replacement so a calendar does not accumulate channels.
 */
export async function startCalendarChannel(input: {
  userId: string;
  connectionId: string;
  collectionId: string;
  remoteCalendarId: string;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}): Promise<ProviderPushSubscription> {
  const availability = googleCalendarPushAvailable(input.env ?? process.env);
  if (!availability.available || !availability.address) {
    throw new Error(`Google Calendar push is not available: ${availability.reason}`);
  }
  const secret = newPushSecret();
  const channelId = `inboxora-${input.collectionId}`;
  const response = await googleApiFetch<CalendarChannelResponse>(
    apiOptions(input),
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(input.remoteCalendarId)}/watch`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: channelId,
        type: 'web_hook',
        address: availability.address,
        token: secret,
        params: { ttl: String(CALENDAR_CHANNEL_TTL_SECONDS) },
      }),
    },
  );
  const expirationMs = Number(response?.expiration);
  const expiresAt = Number.isFinite(expirationMs) && expirationMs > 0
    ? new Date(expirationMs)
    : new Date(Date.now() + CALENDAR_CHANNEL_TTL_SECONDS * 1000);
  return upsertPushSubscription({
    userId: input.userId,
    connectionId: input.connectionId,
    provider: 'google',
    resourceType: 'calendar',
    collectionId: input.collectionId,
    providerSubscriptionId: response?.id ?? channelId,
    providerResource: response?.resourceUri ?? `${CALENDAR_BASE}/calendars/${input.remoteCalendarId}`,
    remoteResourceId: response?.resourceId ?? input.remoteCalendarId,
    secret,
    secretKind: 'channel_token',
    expiresAt,
  });
}

/** Stop one calendar channel. */
export async function stopCalendarChannel(input: {
  userId: string;
  connectionId: string;
  subscription: ProviderPushSubscription;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const channelId = input.subscription.provider_subscription_id;
  if (!channelId) return;
  try {
    await googleApiVoid(apiOptions(input), `${CALENDAR_BASE}/channels/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: channelId,
        ...(input.subscription.remote_resource_id ? { resourceId: input.subscription.remote_resource_id } : {}),
      }),
    });
  } catch (error) {
    // A channel Google no longer has is already stopped.
    if (error instanceof GoogleApiError && error.status === 404) return;
    throw error;
  }
}

/**
 * Bring a connection's Google subscriptions up to date.
 *
 * `mail` when the Gmail watch is available, and one calendar channel per enabled calendar collection the
 * caller names. Missing or expired rows are created; live ones are left alone. Contacts are absent by design:
 * the People API has no push channel for the `otherContacts`/`connections` resources Inboxora syncs, so the
 * contacts sync keeps its sync token and the schedule (documented as polling-only).
 */
export async function ensureGoogleSubscriptions(input: {
  userId: string;
  connectionId: string;
  calendars: Array<{ collectionId: string; remoteCalendarId: string }>;
  includeMail?: boolean;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}): Promise<{ created: string[]; failed: Array<{ resource: string; code: string }> }> {
  const created: string[] = [];
  const failed: Array<{ resource: string; code: string }> = [];
  const env = input.env ?? process.env;

  if (input.includeMail !== false && gmailPushAvailable(env).available) {
    const existing = await findLiveSubscription({ connectionId: input.connectionId, resourceType: 'mail' });
    const live = existing?.status === 'active' && existing.expires_at && new Date(existing.expires_at).getTime() > Date.now() + 60_000;
    if (!live) {
      try {
        await startGmailWatch({ userId: input.userId, connectionId: input.connectionId, ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}), env });
        created.push('mail');
      } catch (error) {
        failed.push({ resource: 'mail', code: (error as { code?: string } | null)?.code ?? 'WATCH_CREATE_FAILED' });
        console.warn(`Gmail watch could not be registered for connection ${input.connectionId}:`, error instanceof Error ? error.message : error);
      }
    }
  }

  if (googleCalendarPushAvailable(env).available) {
    for (const calendar of input.calendars) {
      const existing = await findLiveSubscription({
        connectionId: input.connectionId, resourceType: 'calendar', collectionId: calendar.collectionId,
      });
      const live = existing?.status === 'active' && existing.expires_at && new Date(existing.expires_at).getTime() > Date.now() + 60_000;
      if (live) continue;
      try {
        await startCalendarChannel({
          userId: input.userId,
          connectionId: input.connectionId,
          collectionId: calendar.collectionId,
          remoteCalendarId: calendar.remoteCalendarId,
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
          env,
        });
        created.push(`calendar:${calendar.collectionId}`);
      } catch (error) {
        failed.push({ resource: `calendar:${calendar.collectionId}`, code: (error as { code?: string } | null)?.code ?? 'CHANNEL_CREATE_FAILED' });
        console.warn(`Calendar channel could not be opened for collection ${calendar.collectionId}:`, error instanceof Error ? error.message : error);
      }
    }
  }

  return { created, failed };
}

/**
 * Release the channels of one pulled calendar collection.
 *
 * The subscription row would disappear with the collection through its foreign key, which would leave the
 * Google channel alive and pushing at an endpoint that no longer recognises it. Stopping it first is what
 * makes "remove this calendar" mean the provider forgets it too.
 */
export async function releaseCalendarChannelForCollection(input: {
  userId: string;
  collectionId: string;
  fetchImpl?: FetchLike;
}): Promise<{ attempted: number; failed: number }> {
  const collection = await query<{ connection_id: string | null }>(
    'SELECT connection_id FROM integration_collections WHERE id = $1',
    [input.collectionId],
  );
  const connectionId = collection.rows[0]?.connection_id ?? null;
  if (!connectionId) {
    await markSubscriptionsRemoved({ subscriptionIds: [] });
    return { attempted: 0, failed: 0 };
  }
  const subscriptions = await listSubscriptionsForConnection(connectionId);
  const mine = subscriptions.filter(row => row.resource_type === 'calendar' && row.collection_id === input.collectionId);
  let failed = 0;
  for (const subscription of mine) {
    try {
      await stopCalendarChannel({
        userId: input.userId,
        connectionId,
        subscription,
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      });
    } catch (error) {
      failed += 1;
      console.warn(`Calendar channel ${subscription.id} could not be stopped at Google:`, error instanceof Error ? error.message : error);
    }
  }
  await markSubscriptionsRemoved({ subscriptionIds: mine.map(row => row.id) });
  return { attempted: mine.length, failed };
}

/** Stop every Google subscription of a connection, then mark them removed locally regardless of the answer. */
export async function stopGoogleSubscriptionsForConnection(input: {
  userId: string;
  connectionId: string;
  fetchImpl?: FetchLike;
}): Promise<{ attempted: number; failed: number }> {
  const subscriptions = await listSubscriptionsForConnection(input.connectionId);
  let failed = 0;
  for (const subscription of subscriptions) {
    try {
      if (subscription.resource_type === 'mail') {
        await stopGmailWatch({ userId: input.userId, connectionId: input.connectionId, ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) });
      } else if (subscription.resource_type === 'calendar') {
        await stopCalendarChannel({
          userId: input.userId,
          connectionId: input.connectionId,
          subscription,
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        });
      }
    } catch (error) {
      failed += 1;
      console.warn(`Google subscription ${subscription.id} could not be stopped at Google:`, error instanceof Error ? error.message : error);
    }
  }
  await markSubscriptionsRemoved({ connectionId: input.connectionId });
  return { attempted: subscriptions.length, failed };
}

export async function recordGoogleRenewalFailure(input: {
  subscription: ProviderPushSubscription;
  error: unknown;
}): Promise<void> {
  const code = (input.error as { code?: string } | null)?.code ?? 'SUBSCRIPTION_RENEW_FAILED';
  const retryAfterSeconds = Number((input.error as { retryAfterSeconds?: number } | null)?.retryAfterSeconds);
  await recordSubscriptionFailure({
    id: input.subscription.id,
    code,
    // A watch or channel the provider no longer knows is expired, not broken: recreating it is the fix.
    status: code === 'RESOURCE_NOT_FOUND' ? 'expired' : 'failed',
    ...(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? { retryAfterSeconds } : {}),
  });
}

/** Re-register the Gmail watch, which is what both the renewal sweep and a lost watch do. */
export async function renewGmailWatch(input: {
  userId: string;
  connectionId: string;
  subscription: ProviderPushSubscription;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const refreshed = await startGmailWatch({
    userId: input.userId,
    connectionId: input.connectionId,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  await recordSubscriptionRenewed({ id: input.subscription.id, expiresAt: refreshed.expires_at });
}

/** Replace a calendar channel: open the new one, then stop the old one so only one is live per calendar. */
export async function renewCalendarChannel(input: {
  userId: string;
  connectionId: string;
  subscription: ProviderPushSubscription;
  remoteCalendarId: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const previousChannelId = input.subscription.provider_subscription_id;
  const previousResourceId = input.subscription.remote_resource_id;
  const replacement = await startCalendarChannel({
    userId: input.userId,
    connectionId: input.connectionId,
    collectionId: input.subscription.collection_id ?? '',
    remoteCalendarId: input.remoteCalendarId,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  if (previousChannelId && previousChannelId !== replacement.provider_subscription_id) {
    try {
      await stopCalendarChannel({
        userId: input.userId,
        connectionId: input.connectionId,
        subscription: { ...replacement, provider_subscription_id: previousChannelId, remote_resource_id: previousResourceId },
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      });
    } catch (error) {
      // A channel that cannot be stopped will lapse on its own within its TTL; the live row is the new one.
      console.warn(`Previous calendar channel ${previousChannelId} could not be stopped:`, error instanceof Error ? error.message : error);
    }
  }
}
