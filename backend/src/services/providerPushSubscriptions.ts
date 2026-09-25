import crypto from 'crypto';
import { query, withTransaction } from './db.js';
import type { PoolClient } from 'pg';
import { providerPushEnabled, publicWebhookBaseUrl } from './providerPushConfig.js';

/**
 * The durable record of every provider-side notification subscription or channel Inboxora holds.
 *
 * One table, one vocabulary, three providers' mechanisms: a Microsoft Graph subscription for
 * `messages`/`events`/`contacts`, a Gmail `users.watch`, and one Google Calendar channel per pulled
 * calendar. The secrets that authenticate an inbound notification are stored **hashed**, because nothing
 * needs the plaintext back: an inbound payload only has to be compared against the hash, a renewal never
 * re-sends the secret, and a recreated subscription gets a fresh one.
 *
 * Nothing here runs a sync. A subscription exists so that a notification can be turned into a sync hint;
 * the sync itself is the existing delta/history/sync-token path, unchanged.
 */

export type ProviderPushProvider = 'microsoft' | 'google';
export type ProviderPushResourceType = 'mail' | 'calendar' | 'contacts';
export type ProviderPushStatus = 'active' | 'renewing' | 'expired' | 'removed' | 'failed' | 'disabled';

export const PROVIDER_PUSH_STATUSES: readonly ProviderPushStatus[] = [
  'active', 'renewing', 'expired', 'removed', 'failed', 'disabled',
];

/** The validation secret's role, which decides how an inbound request is authenticated. */
export type ProviderPushSecretKind = 'client_state' | 'channel_token' | 'pubsub_token';

export interface ProviderPushSubscription {
  id: string;
  user_id: string;
  provider_connection_id: string;
  provider: ProviderPushProvider;
  resource_type: ProviderPushResourceType;
  collection_id: string | null;
  provider_subscription_id: string | null;
  provider_resource: string | null;
  remote_resource_id: string | null;
  secret_kind: ProviderPushSecretKind;
  expires_at: string | null;
  status: ProviderPushStatus;
  last_notification_at: string | null;
  last_renewed_at: string | null;
  last_error_code: string | null;
  failure_count: number;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The columns every read returns. `secret_hash` is deliberately absent: it never leaves this module. */
const SUBSCRIPTION_COLUMNS = `id, user_id, provider_connection_id, provider, resource_type, collection_id,
  provider_subscription_id, provider_resource, remote_resource_id, secret_kind, expires_at, status,
  last_notification_at, last_renewed_at, last_error_code, failure_count, next_attempt_at, created_at, updated_at`;

/**
 * A fresh validation secret. 32 random bytes, url-safe, which fits Graph's 128-character `clientState`
 * limit and Google's opaque channel-token usage.
 */
export function newPushSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** The stored form of a secret. SHA-256 is enough: the value is high-entropy and never chosen by a user. */
export function hashPushSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time comparison of an inbound secret against the stored hash. */
export function pushSecretMatches(secret: unknown, storedHash: string | null | undefined): boolean {
  if (typeof secret !== 'string' || !secret || !storedHash) return false;
  const candidate = Buffer.from(hashPushSecret(secret), 'utf8');
  const expected = Buffer.from(storedHash, 'utf8');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export interface UpsertPushSubscriptionInput {
  userId: string;
  connectionId: string;
  provider: ProviderPushProvider;
  resourceType: ProviderPushResourceType;
  collectionId?: string | null;
  providerSubscriptionId?: string | null;
  providerResource?: string | null;
  remoteResourceId?: string | null;
  /** The plaintext secret to authenticate inbound notifications; it is hashed before it is stored. */
  secret?: string | null;
  secretKind?: ProviderPushSecretKind;
  expiresAt?: Date | string | null;
}

/**
 * Record a subscription the provider accepted.
 *
 * The live-scope unique index makes this the single row for one (connection, resource, collection): a
 * recreate after `subscriptionRemoved` updates the row the notification arrived on instead of adding a
 * second one, which is the difference between one renewal and a growing pile of them.
 */
export async function upsertPushSubscription(input: UpsertPushSubscriptionInput): Promise<ProviderPushSubscription> {
  const result = await query<ProviderPushSubscription>(
    `INSERT INTO provider_push_subscriptions
       (user_id, provider_connection_id, provider, resource_type, collection_id, provider_subscription_id,
        provider_resource, remote_resource_id, secret_hash, secret_kind, expires_at, status, last_renewed_at,
        last_error_code, failure_count, next_attempt_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',NOW(),NULL,0,NULL)
     ON CONFLICT (provider_connection_id, resource_type, COALESCE(collection_id, '00000000-0000-0000-0000-000000000000'::uuid))
       WHERE status <> 'removed'
     DO UPDATE SET
       provider_subscription_id = EXCLUDED.provider_subscription_id,
       provider_resource = EXCLUDED.provider_resource,
       remote_resource_id = EXCLUDED.remote_resource_id,
       secret_hash = EXCLUDED.secret_hash,
       secret_kind = EXCLUDED.secret_kind,
       expires_at = EXCLUDED.expires_at,
       status = 'active',
       last_renewed_at = NOW(),
       last_error_code = NULL,
       failure_count = 0,
       next_attempt_at = NULL,
       updated_at = NOW()
     RETURNING ${SUBSCRIPTION_COLUMNS}`,
    [
      input.userId, input.connectionId, input.provider, input.resourceType, input.collectionId ?? null,
      input.providerSubscriptionId ?? null, input.providerResource ?? null, input.remoteResourceId ?? null,
      input.secret ? hashPushSecret(input.secret) : null, input.secretKind ?? 'client_state',
      input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
    ],
  );
  return result.rows[0]!;
}

/** One live subscription, by its provider-side id (the only inbound identifier to be trusted). */
export async function findSubscriptionByProviderId(
  provider: ProviderPushProvider,
  providerSubscriptionId: string,
): Promise<ProviderPushSubscription | null> {
  const result = await query<ProviderPushSubscription>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM provider_push_subscriptions
      WHERE provider = $1 AND provider_subscription_id = $2 AND status <> 'removed'
      ORDER BY created_at DESC LIMIT 1`,
    [provider, providerSubscriptionId],
  );
  return result.rows[0] ?? null;
}

/** One live subscription for a scope, which is what a renewal or a cleanup works on. */
export async function findLiveSubscription(input: {
  connectionId: string;
  resourceType: ProviderPushResourceType;
  collectionId?: string | null;
}): Promise<ProviderPushSubscription | null> {
  const result = await query<ProviderPushSubscription>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM provider_push_subscriptions
      WHERE provider_connection_id = $1 AND resource_type = $2
        AND COALESCE(collection_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND status <> 'removed'
      LIMIT 1`,
    [input.connectionId, input.resourceType, input.collectionId ?? null],
  );
  return result.rows[0] ?? null;
}

export async function listSubscriptionsForConnection(connectionId: string): Promise<ProviderPushSubscription[]> {
  const result = await query<ProviderPushSubscription>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM provider_push_subscriptions
      WHERE provider_connection_id = $1 AND status <> 'removed'
      ORDER BY resource_type, created_at`,
    [connectionId],
  );
  return result.rows;
}

/**
 * Subscriptions whose renewal is due, oldest expiry first.
 *
 * `aheadMinutes` is the safety margin: a subscription is renewed before it expires, never after, so an
 * outage or a slow tick cannot leave a mailbox unwatched. Rows in a backoff window (`next_attempt_at`) are
 * skipped, which is what keeps a failing renewal from becoming a retry storm.
 */
export async function listSubscriptionsDueForRenewal(input: {
  aheadMinutes: number;
  limit?: number;
  now?: Date;
}): Promise<ProviderPushSubscription[]> {
  const ahead = Math.max(1, Math.floor(input.aheadMinutes));
  const result = await query<ProviderPushSubscription>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM provider_push_subscriptions
      WHERE status IN ('active', 'expired', 'failed')
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
        AND (expires_at IS NULL OR expires_at <= NOW() + make_interval(mins => $1))
      ORDER BY expires_at NULLS FIRST, created_at
      LIMIT $2`,
    [ahead, Math.min(Math.max(1, input.limit ?? 50), 500)],
  );
  return result.rows;
}

/** Record one inbound notification: the subscription was used, so it is alive. */
export async function recordSubscriptionNotification(subscriptionId: string): Promise<void> {
  await query(
    `UPDATE provider_push_subscriptions
        SET last_notification_at = NOW(), status = CASE WHEN status = 'expired' THEN 'active' ELSE status END,
            updated_at = NOW()
      WHERE id = $1`,
    [subscriptionId],
  );
}

/** A successful renewal or recreate: a new expiry, no failure state. */
export async function recordSubscriptionRenewed(input: {
  id: string;
  expiresAt?: Date | string | null;
  providerSubscriptionId?: string | null;
  secret?: string | null;
}): Promise<void> {
  await query(
    `UPDATE provider_push_subscriptions
        SET status = 'active', expires_at = COALESCE($2, expires_at),
            provider_subscription_id = COALESCE($3, provider_subscription_id),
            secret_hash = COALESCE($4, secret_hash),
            last_renewed_at = NOW(), last_error_code = NULL, failure_count = 0, next_attempt_at = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [
      input.id,
      input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
      input.providerSubscriptionId ?? null,
      input.secret ? hashPushSecret(input.secret) : null,
    ],
  );
}

/**
 * A failed operation: the status, the reason and the backoff.
 *
 * The next attempt is pushed out exponentially and never cleared by a failure, so a provider outage or a
 * revoked grant is retried with a widening gap instead of on every tick.
 */
export async function recordSubscriptionFailure(input: {
  id: string;
  code: string;
  status?: Extract<ProviderPushStatus, 'failed' | 'expired' | 'disabled'>;
  retryAfterSeconds?: number;
  baseDelayMs?: number;
}): Promise<void> {
  const base = Math.max(1000, input.baseDelayMs ?? 60_000);
  const delaySeconds = Number.isFinite(input.retryAfterSeconds) && Number(input.retryAfterSeconds) > 0
    ? Math.floor(Number(input.retryAfterSeconds))
    : Math.min(6 * 3600, Math.floor(base / 1000) * 2 ** Math.min(6, 1));
  await query(
    `UPDATE provider_push_subscriptions
        SET status = $2,
            last_error_code = $3,
            failure_count = failure_count + 1,
            next_attempt_at = NOW() + make_interval(secs => $4),
            updated_at = NOW()
      WHERE id = $1`,
    [input.id, input.status ?? 'failed', input.code, delaySeconds],
  );
}

/**
 * Mark subscriptions removed locally.
 *
 * Always called after a disconnect, a delete, a disable or a revoked grant — and called whether or not the
 * provider-side cleanup succeeded: the local row is what stops the renewal sweep, so a provider outage can
 * never leave a zombie subscription being renewed for an account that no longer wants it.
 */
export async function markSubscriptionsRemoved(input: {
  connectionId?: string | null;
  subscriptionIds?: string[];
  status?: Extract<ProviderPushStatus, 'removed' | 'disabled'>;
}): Promise<number> {
  const status = input.status ?? 'removed';
  if (input.subscriptionIds?.length) {
    const result = await query(
      `UPDATE provider_push_subscriptions
          SET status = $2, next_attempt_at = NULL, updated_at = NOW()
        WHERE id = ANY($1::uuid[]) AND status <> $2`,
      [input.subscriptionIds, status],
    );
    return result.rowCount ?? 0;
  }
  if (!input.connectionId) return 0;
  const result = await query(
    `UPDATE provider_push_subscriptions
        SET status = $2, next_attempt_at = NULL, updated_at = NOW()
      WHERE provider_connection_id = $1 AND status <> $2`,
    [input.connectionId, status],
  );
  return result.rowCount ?? 0;
}

/** A subscription row as the admin diagnostics report it: identity, state and times, never a secret. */
export interface PushSubscriptionDiagnostic {
  id: string;
  connectionId: string;
  provider: ProviderPushProvider;
  resourceType: ProviderPushResourceType;
  collectionId: string | null;
  status: ProviderPushStatus;
  expiresAt: string | null;
  lastNotificationAt: string | null;
  lastRenewedAt: string | null;
  lastErrorCode: string | null;
}

export async function listSubscriptionDiagnostics(): Promise<PushSubscriptionDiagnostic[]> {
  const result = await query<ProviderPushSubscription>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM provider_push_subscriptions WHERE status <> 'removed'`,
  );
  return result.rows.map(row => ({
    id: row.id,
    connectionId: row.provider_connection_id,
    provider: row.provider,
    resourceType: row.resource_type,
    collectionId: row.collection_id,
    status: row.status,
    expiresAt: row.expires_at,
    lastNotificationAt: row.last_notification_at,
    lastRenewedAt: row.last_renewed_at,
    lastErrorCode: row.last_error_code,
  }));
}

/**
 * Whether push can be offered at all on this installation.
 *
 * An installation without a reachable HTTPS URL, or with push switched off, keeps synchronising by polling:
 * this answer is reported, never treated as a broken account.
 */
export function pushAvailability(): { enabled: boolean; webhookBaseUrl: string | null; reason: string | null } {
  if (!providerPushEnabled()) return { enabled: false, webhookBaseUrl: null, reason: 'PROVIDER_PUSH_DISABLED' };
  const base = publicWebhookBaseUrl();
  if (!base) return { enabled: false, webhookBaseUrl: null, reason: 'PUBLIC_URL_NOT_CONFIGURED' };
  return { enabled: true, webhookBaseUrl: base, reason: null };
}

/** Run a callback inside one transaction; used by the cleanup path so local state and hints move together. */
export async function withSubscriptionTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(fn);
}
