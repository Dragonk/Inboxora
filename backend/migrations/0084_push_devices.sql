-- Native push device registry (Android FCM / UnifiedPush), separate from the
-- browser Web Push subscriptions in push_subscriptions. A device authenticates
-- with a revocable, user-scoped device token (issued once at registration and
-- stored only as a bcrypt hash). The provider endpoint/token is stored encrypted
-- at rest; the dispatcher decrypts it only when sending.
CREATE TABLE IF NOT EXISTS push_devices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id      TEXT NOT NULL CHECK (char_length(device_id) BETWEEN 1 AND 128),
  platform       TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web', 'desktop')),
  transport      TEXT NOT NULL CHECK (transport IN ('unifiedpush', 'fcm', 'webpush')),
  endpoint       TEXT NOT NULL,
  token_prefix   TEXT,
  token_hash     TEXT,
  app_version    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  failure_count  INTEGER NOT NULL DEFAULT 0,
  disabled_at    TIMESTAMPTZ,
  UNIQUE (user_id, device_id)
);

-- Dispatch reads only active devices for one user.
CREATE INDEX IF NOT EXISTS push_devices_user_active_idx
  ON push_devices (user_id)
  WHERE disabled_at IS NULL;

-- Device-token authentication looks the row up by its public prefix.
CREATE INDEX IF NOT EXISTS push_devices_token_prefix_idx
  ON push_devices (token_prefix)
  WHERE disabled_at IS NULL AND token_prefix IS NOT NULL;

-- Cleanup of expired/stale registrations scans by last activity.
CREATE INDEX IF NOT EXISTS push_devices_last_seen_idx
  ON push_devices (last_seen);
