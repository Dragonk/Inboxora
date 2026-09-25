-- Provider push subscriptions and coalesced sync hints.
--
-- Push-assisted synchronisation needs two durable facts, and both are additive: nothing existing changes,
-- and an installation that never enables push behaves exactly as before.
--
-- `provider_push_subscriptions` records one provider-side notification subscription or channel: the Graph
-- subscription for messages/events/contacts, the Gmail `users.watch`, or one Google Calendar channel per
-- calendar collection. The validation secret is stored **hashed** (`secret_hash`): the inbound payload only
-- ever has to be compared against it, a renew never re-sends it, and a recreated subscription gets a fresh
-- one, so the plaintext never needs to be kept and can never leak from the database or an API response.
--
-- `provider_sync_hints` is the coalescing buffer between a notification and the existing delta sync. The
-- unique index is per (connection, resource, collection): a burst of twenty notifications for one mailbox
-- collapses into the single row that already exists, `requested_at` moves forward, and the row is deleted
-- after a sync **only** when no newer hint arrived while that sync ran — which is what keeps a notification
-- from being lost instead of queued behind a running sync.

CREATE TABLE IF NOT EXISTS provider_push_subscriptions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  provider               VARCHAR(32) NOT NULL CHECK (provider IN ('microsoft', 'google')),
  resource_type          VARCHAR(16) NOT NULL CHECK (resource_type IN ('mail', 'calendar', 'contacts')),
  -- The pulled collection this channel follows, when the channel is per collection (Google Calendar).
  -- Microsoft's Outlook subscriptions and Gmail's watch cover the whole mailbox, so theirs is NULL.
  collection_id          UUID REFERENCES integration_collections(id) ON DELETE CASCADE,
  -- The provider's own identifiers, as returned by the subscription/channel call.
  provider_subscription_id TEXT,
  provider_resource        TEXT,
  remote_resource_id       TEXT,
  -- Schema of the validation secret, never the secret itself.
  secret_hash            TEXT,
  secret_kind            VARCHAR(16) NOT NULL DEFAULT 'client_state'
                           CHECK (secret_kind IN ('client_state', 'channel_token', 'pubsub_token')),
  expires_at             TIMESTAMPTZ,
  status                 VARCHAR(16) NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'renewing', 'expired', 'removed', 'failed', 'disabled')),
  last_notification_at   TIMESTAMPTZ,
  last_renewed_at        TIMESTAMPTZ,
  last_error_code        TEXT,
  failure_count          INTEGER NOT NULL DEFAULT 0,
  -- Backoff: when a renewal may be attempted again after a failure.
  next_attempt_at        TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live subscription per (connection, resource type, collection). `removed` rows are excluded so a
-- recreated subscription never collides with the tombstone of the one it replaced.
CREATE UNIQUE INDEX IF NOT EXISTS provider_push_subscriptions_live_scope
  ON provider_push_subscriptions (
    provider_connection_id,
    resource_type,
    COALESCE(collection_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status <> 'removed';

-- The renewal sweep reads rows by status and expiry.
CREATE INDEX IF NOT EXISTS provider_push_subscriptions_renewal
  ON provider_push_subscriptions (status, expires_at)
  WHERE status IN ('active', 'expired', 'failed');

CREATE INDEX IF NOT EXISTS provider_push_subscriptions_connection
  ON provider_push_subscriptions (provider_connection_id);

CREATE TABLE IF NOT EXISTS provider_sync_hints (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  provider               VARCHAR(32) NOT NULL CHECK (provider IN ('microsoft', 'google')),
  resource_type          VARCHAR(16) NOT NULL CHECK (resource_type IN ('mail', 'calendar', 'contacts')),
  collection_id          UUID REFERENCES integration_collections(id) ON DELETE CASCADE,
  requested_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Debounce: a burst inside this window coalesces into one sync.
  run_after              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at             TIMESTAMPTZ,
  claim_owner            TEXT,
  attempts               INTEGER NOT NULL DEFAULT 0,
  last_error_code        TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_sync_hints_scope
  ON provider_sync_hints (
    provider_connection_id,
    resource_type,
    COALESCE(collection_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS provider_sync_hints_due
  ON provider_sync_hints (run_after);
