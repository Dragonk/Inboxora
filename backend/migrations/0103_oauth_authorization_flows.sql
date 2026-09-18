-- P04: server-side state for OAuth authorization flows.
--
-- The flow state belongs in the database, not in one session key: a session can
-- hold several parallel flows (one per account/purpose), a restart must not lose
-- a pending flow, and the state must be replay-proof. `state_hash` stores only a
-- hash of the one-time state value, so a read of this table cannot be replayed as
-- a callback. The PKCE verifier is encrypted with the existing key.
--
-- `config_revision` pins the provider configuration that started the flow: a
-- callback that arrives after the administrator changed the Client ID must not be
-- completed against the new configuration.
--
-- Expand-only: a new table, no existing row or column is touched.

CREATE TABLE IF NOT EXISTS oauth_authorization_flows (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider            VARCHAR(32) NOT NULL CHECK (provider IN ('microsoft', 'google')),
  purpose             VARCHAR(32) NOT NULL
                        CHECK (purpose IN ('new_account', 'mail_migration', 'calendar_enable', 'contacts_enable')),
  -- Set only when the flow reconnects/enables an existing mailbox.
  target_account_id   UUID,
  state_hash          TEXT NOT NULL UNIQUE,
  code_verifier_enc   TEXT,
  nonce               TEXT,
  requested_scopes    TEXT[] NOT NULL DEFAULT '{}',
  return_route        TEXT,
  config_revision     TEXT,
  auth_flow           VARCHAR(32) NOT NULL DEFAULT 'browser'
                        CHECK (auth_flow IN ('browser', 'device_code')),
  status              VARCHAR(16) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'exchanging', 'completed', 'failed', 'expired', 'cancelled')),
  error_code          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,
  completed_at        TIMESTAMPTZ,
  CONSTRAINT oauth_authorization_flows_account_owner_fk
    FOREIGN KEY (target_account_id, user_id) REFERENCES email_accounts(id, user_id) ON DELETE CASCADE
);

-- Listing a user's pending flows (diagnostics, cancel-on-logout).
CREATE INDEX IF NOT EXISTS oauth_authorization_flows_user_idx
  ON oauth_authorization_flows (user_id, status, expires_at);

-- Expiry sweeping only looks at flows that can still be used.
CREATE INDEX IF NOT EXISTS oauth_authorization_flows_expiry_idx
  ON oauth_authorization_flows (expires_at)
  WHERE status = 'pending';
