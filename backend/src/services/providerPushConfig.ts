/**
 * Where push-assisted synchronisation is allowed to reach.
 *
 * Provider notifications are delivered to a URL the provider calls from the public internet, so the URL is
 * derived from the trusted `APP_URL` — never typed per account, and never taken from a request. When it
 * cannot be derived, push is simply unavailable and polling carries on: an installation behind a private
 * network is a supported configuration, not a broken one.
 */

/** Default renewal sweep cadence and how far ahead of expiry a subscription is renewed. */
export const DEFAULT_RENEW_AHEAD_MINUTES = 30;
export const GOOGLE_RENEW_AHEAD_MINUTES_DEFAULT = 24 * 60;

/**
 * Whether the operator enabled push-assisted synchronisation.
 *
 * Off by default for a fresh installation: nothing calls out to a provider to register a subscription until
 * someone asks for it, and every existing deployment keeps polling exactly as before after an upgrade.
 */
export function providerPushEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PROVIDER_PUSH_ENABLED;
  if (raw === undefined || raw === '') return false;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

/**
 * The public HTTPS base the provider calls, from `APP_URL`.
 *
 * HTTPS is required in production: a provider will not deliver to plain HTTP, and pretending otherwise
 * would produce subscriptions that are created and then never used. In development an `http://localhost`
 * or `http://127.0.0.1` URL is accepted, because that is what a tunnel-less local setup has.
 */
export function publicWebhookBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = typeof env.APP_URL === 'string' ? env.APP_URL.trim() : '';
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  if (parsed.protocol !== 'https:' && !isLocal) return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/** The absolute URL of one webhook endpoint, or null when push cannot be offered. */
export function publicWebhookUrl(path: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const base = publicWebhookBaseUrl(env);
  if (!base) return null;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** How far ahead of expiry the renewal sweep acts, in minutes. */
export function renewAheadMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PROVIDER_PUSH_RENEW_AHEAD_MINUTES);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RENEW_AHEAD_MINUTES;
  return Math.min(7 * 24 * 60, Math.floor(raw));
}

/**
 * The debounce window a burst of notifications collapses into.
 *
 * A mailbox that receives a hundred messages at once produces a hundred notifications; the sync they ask for
 * is the same sync. A short window is enough to coalesce the burst without making a single event feel slow.
 */
export function syncHintDebounceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PROVIDER_SYNC_HINT_DEBOUNCE_MS);
  if (!Number.isFinite(raw) || raw < 0) return 2000;
  return Math.min(60_000, Math.floor(raw));
}

/** How often the hint worker looks for due hints, in milliseconds. */
export function syncHintPollMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PROVIDER_SYNC_HINT_POLL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 15_000;
  return Math.max(1000, Math.min(5 * 60_000, Math.floor(raw)));
}

/** The Pub/Sub topic a Gmail watch is registered against, when the administrator configured one. */
export function googlePubSubTopic(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = typeof env.GOOGLE_PUBSUB_TOPIC === 'string' ? env.GOOGLE_PUBSUB_TOPIC.trim() : '';
  if (!raw) return null;
  // A topic is `projects/{project}/topics/{name}`; anything else would be rejected by Gmail.
  return /^projects\/[^/\s]+\/topics\/[^/\s]+$/.test(raw) ? raw : null;
}

/**
 * The shared secret a Pub/Sub push subscription must present.
 *
 * A Pub/Sub push endpoint is a URL anyone who learns it can post to, so it carries a high-entropy secret in
 * the request — as a path segment or a query parameter — and the endpoint compares it against the stored
 * hash of the subscription's own token. It is never logged and never returned to a client.
 */
export function googlePubSubVerificationToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = typeof env.GOOGLE_PUBSUB_VERIFICATION_TOKEN === 'string' ? env.GOOGLE_PUBSUB_VERIFICATION_TOKEN.trim() : '';
  return raw.length >= 16 ? raw : null;
}

/** Whether Gmail push is fully configured: a reachable endpoint, a topic and a verification token. */
export function gmailPushConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return providerPushEnabled(env)
    && publicWebhookUrl('/api/provider-webhooks/gmail', env) !== null
    && googlePubSubTopic(env) !== null
    && googlePubSubVerificationToken(env) !== null;
}
