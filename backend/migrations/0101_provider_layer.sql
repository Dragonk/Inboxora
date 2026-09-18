-- Provider layer foundation (v4 plan §5.1): provider connections, OAuth grants,
-- per-account integrations and notice preferences, external source connections,
-- collection metadata, remote object links, a durable operation journal and sync
-- checkpoints.
--
-- Expand-only migration: every change is additive, no existing column is
-- rewritten, no default transport is changed and no remote/provider mutation is
-- performed. Old application versions keep working because the new columns are
-- nullable or carry a default that matches current behaviour, and the widened
-- `calendars.source` check still accepts every previously valid value.

-- ── Account-owner composite keys ─────────────────────────────────────────────
-- Composite foreign keys below need a unique (id, user_id) target so a child row
-- can never point at another user's account with an inconsistent user_id.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'email_accounts_id_user_id_key'
  ) THEN
    ALTER TABLE email_accounts ADD CONSTRAINT email_accounts_id_user_id_key UNIQUE (id, user_id);
  END IF;
END $$;

-- ── provider_connections ─────────────────────────────────────────────────────
-- Identity comes from the verified grant (issuer + subject), never from the
-- e-mail address, which can change or be aliased.
CREATE TABLE IF NOT EXISTS provider_connections (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider             VARCHAR(32) NOT NULL CHECK (provider IN ('microsoft', 'google')),
  issuer               TEXT,
  subject              TEXT,
  tenant_id            TEXT,
  provider_user_id     TEXT,
  client_config_id     TEXT,
  identity_verified_at TIMESTAMPTZ,
  status               VARCHAR(32) NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'reauth_required', 'revoked', 'disabled')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_connections_identity_key
  ON provider_connections (user_id, provider, issuer, subject)
  WHERE issuer IS NOT NULL AND subject IS NOT NULL;

CREATE INDEX IF NOT EXISTS provider_connections_user_idx
  ON provider_connections (user_id, provider, status);

-- ── oauth_grants ─────────────────────────────────────────────────────────────
-- One grant per connection and audience. The client auth method belongs to the
-- grant: a public-client (device code) grant is refreshed without a secret even
-- when the instance also stores a confidential web secret.
CREATE TABLE IF NOT EXISTS oauth_grants (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id          UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  audience               TEXT NOT NULL,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  expires_at             TIMESTAMPTZ,
  scopes                 TEXT[] NOT NULL DEFAULT '{}',
  auth_flow              VARCHAR(32) NOT NULL DEFAULT 'browser'
                           CHECK (auth_flow IN ('browser', 'device_code')),
  client_auth_method     VARCHAR(32) NOT NULL DEFAULT 'confidential'
                           CHECK (client_auth_method IN ('confidential', 'public')),
  client_config_id       TEXT,
  client_id_at_issue     TEXT,
  generation             BIGINT NOT NULL DEFAULT 1,
  status                 VARCHAR(32) NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'reauth_required', 'revoked')),
  reauth_reason          TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (connection_id, audience)
);

CREATE INDEX IF NOT EXISTS oauth_grants_status_idx
  ON oauth_grants (status, expires_at);

-- ── email_accounts: transport, migration and connection columns ──────────────
-- All nullable/defaulted so pre-v4 rows keep working; `protocol` stays as a
-- compatibility field and is not the authoritative transport decision.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS mail_transport VARCHAR(32);
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS provider_connection_id UUID
  REFERENCES provider_connections(id) ON DELETE SET NULL;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS provider_mailbox_id TEXT;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS transport_generation BIGINT NOT NULL DEFAULT 1;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS migration_state VARCHAR(32) NOT NULL DEFAULT 'not_applicable';
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS migration_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS migration_error_code TEXT;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS mail_method_preference VARCHAR(32);
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS google_mail_migration_requested_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_accounts_mail_transport_check') THEN
    ALTER TABLE email_accounts ADD CONSTRAINT email_accounts_mail_transport_check
      CHECK (mail_transport IS NULL OR mail_transport IN ('imap_smtp', 'microsoft_graph', 'gmail_api'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_accounts_migration_state_check') THEN
    ALTER TABLE email_accounts ADD CONSTRAINT email_accounts_migration_state_check
      CHECK (migration_state IN (
        'not_applicable', 'available', 'classified', 'authorization_required',
        'admin_configuration_required', 'authorized', 'inventory', 'backfill',
        'reconcile', 'ready_to_switch', 'draining', 'switching', 'active_native',
        'paused', 'failed_retryable', 'needs_review'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS email_accounts_transport_idx
  ON email_accounts (user_id, mail_transport, migration_state);

-- ── account_notice_preferences ───────────────────────────────────────────────
-- Per user and account recommendation suppression. This never suppresses auth,
-- sync or Microsoft-requirement notices — only the Google API recommendation.
CREATE TABLE IF NOT EXISTS account_notice_preferences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id  UUID NOT NULL,
  notice_type VARCHAR(64) NOT NULL
                CHECK (notice_type IN ('google_mail_api_recommendation')),
  suppressed  BOOLEAN NOT NULL DEFAULT false,
  revision    BIGINT NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, account_id, notice_type),
  CONSTRAINT account_notice_preferences_account_owner_fk
    FOREIGN KEY (account_id, user_id) REFERENCES email_accounts(id, user_id) ON DELETE CASCADE
);

-- ── account_integrations ─────────────────────────────────────────────────────
-- Independent calendars/contacts switches with their own auth and sync state.
CREATE TABLE IF NOT EXISTS account_integrations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id       UUID NOT NULL,
  feature          VARCHAR(16) NOT NULL CHECK (feature IN ('calendars', 'contacts')),
  enabled          BOOLEAN NOT NULL DEFAULT false,
  requested_access VARCHAR(16) NOT NULL DEFAULT 'source'
                     CHECK (requested_access IN ('source', 'read_only')),
  auth_status      VARCHAR(32) NOT NULL DEFAULT 'disabled'
                     CHECK (auth_status IN ('disabled', 'authorization_required', 'authorized', 'error')),
  sync_status      VARCHAR(32) NOT NULL DEFAULT 'idle'
                     CHECK (sync_status IN ('idle', 'syncing', 'active', 'error')),
  selection_policy VARCHAR(32) NOT NULL DEFAULT 'selected'
                     CHECK (selection_policy IN ('selected', 'all')),
  last_attempt_at  TIMESTAMPTZ,
  last_success_at  TIMESTAMPTZ,
  error_code       TEXT,
  revision         BIGINT NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, feature),
  CONSTRAINT account_integrations_account_owner_fk
    FOREIGN KEY (account_id, user_id) REFERENCES email_accounts(id, user_id) ON DELETE CASCADE
);

-- ── source_connections ───────────────────────────────────────────────────────
-- Standalone CalDAV/CardDAV/ICS sources, independent of mail accounts. Multiple
-- servers and identities per user are allowed.
CREATE TABLE IF NOT EXISTS source_connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            VARCHAR(16) NOT NULL CHECK (kind IN ('caldav', 'carddav', 'ical_url')),
  label           TEXT,
  url_encrypted   TEXT,
  url_fingerprint TEXT,
  host_policy     JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  revision        BIGINT NOT NULL DEFAULT 1,
  last_success_at TIMESTAMPTZ,
  error_code      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS source_connections_url_key
  ON source_connections (user_id, url_fingerprint)
  WHERE url_fingerprint IS NOT NULL;

-- ── integration_collections ──────────────────────────────────────────────────
-- Shared collection metadata. It links to the existing domain table instead of
-- duplicating its contents; a collection belongs to a mail connection or to a
-- standalone source connection, never both.
CREATE TABLE IF NOT EXISTS integration_collections (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id          UUID REFERENCES provider_connections(id) ON DELETE CASCADE,
  source_connection_id   UUID REFERENCES source_connections(id) ON DELETE CASCADE,
  account_id             UUID,
  kind                   VARCHAR(16) NOT NULL
                           CHECK (kind IN ('calendar', 'address_book', 'mail_folder', 'mail_label')),
  remote_id              TEXT NOT NULL,
  local_calendar_id      UUID REFERENCES calendars(id) ON DELETE SET NULL,
  local_address_book_id  UUID REFERENCES address_books(id) ON DELETE SET NULL,
  enabled                BOOLEAN NOT NULL DEFAULT true,
  source_access          VARCHAR(16) NOT NULL DEFAULT 'read_only'
                           CHECK (source_access IN ('read_only', 'read_write')),
  user_access            VARCHAR(16) NOT NULL DEFAULT 'source'
                           CHECK (user_access IN ('source', 'read_only')),
  dav_mode               VARCHAR(16) NOT NULL DEFAULT 'off'
                           CHECK (dav_mode IN ('off', 'read_only', 'read_write')),
  capability_version     BIGINT NOT NULL DEFAULT 1,
  capabilities           JSONB NOT NULL DEFAULT '{}'::jsonb,
  sync_coverage          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (connection_id IS NOT NULL OR source_connection_id IS NOT NULL),
  CONSTRAINT integration_collections_account_owner_fk
    FOREIGN KEY (account_id, user_id) REFERENCES email_accounts(id, user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS integration_collections_connection_remote_key
  ON integration_collections (
    COALESCE(connection_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(source_connection_id, '00000000-0000-0000-0000-000000000000'::uuid),
    kind, remote_id);

-- ── remote_object_links ──────────────────────────────────────────────────────
-- Local object <-> remote resource identity and version. Opaque remote ids are
-- stored as text and never parsed as numbers.
CREATE TABLE IF NOT EXISTS remote_object_links (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id       UUID REFERENCES provider_connections(id) ON DELETE CASCADE,
  source_connection_id UUID REFERENCES source_connections(id) ON DELETE CASCADE,
  collection_id       UUID NOT NULL REFERENCES integration_collections(id) ON DELETE CASCADE,
  object_type         VARCHAR(16) NOT NULL
                        CHECK (object_type IN ('calendar_event', 'contact', 'message')),
  local_id            UUID,
  local_href          TEXT,
  collection_remote_id TEXT NOT NULL,
  object_remote_id    TEXT NOT NULL,
  remote_href         TEXT,
  remote_version      TEXT,
  base_hash           TEXT,
  status              VARCHAR(16) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'deleted', 'quarantined', 'conflict')),
  last_generation     BIGINT NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (collection_id, object_remote_id)
);

CREATE INDEX IF NOT EXISTS remote_object_links_local_idx
  ON remote_object_links (collection_id, local_id);

-- ── provider_operations ──────────────────────────────────────────────────────
-- Durable journal of intent and result. The same idempotency key with a
-- different payload hash is a conflict, not a cached result.
CREATE TABLE IF NOT EXISTS provider_operations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id       UUID,
  connection_id    UUID REFERENCES provider_connections(id) ON DELETE SET NULL,
  collection_id    UUID REFERENCES integration_collections(id) ON DELETE SET NULL,
  resource_type    VARCHAR(32) NOT NULL,
  operation        VARCHAR(32) NOT NULL,
  resource_id      UUID,
  idempotency_key  TEXT,
  payload_hash     TEXT,
  status           VARCHAR(32) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'in_flight', 'committed', 'accepted_pending',
                                       'outcome_unknown', 'conflict', 'failed', 'cancelled')),
  upstream_ref     JSONB,
  expected_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  error_code       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_operations_account_owner_fk
    FOREIGN KEY (account_id, user_id) REFERENCES email_accounts(id, user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_operations_idempotency_key
  ON provider_operations (user_id, COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid), idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS provider_operations_pending_idx
  ON provider_operations (status, next_attempt_at);

-- ── sync_states ──────────────────────────────────────────────────────────────
-- Per connection/feature/collection/coverage cursor and lease. Cursors are
-- opaque strings; 64-bit provider history ids are never converted to numbers.
CREATE TABLE IF NOT EXISTS sync_states (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id        UUID REFERENCES provider_connections(id) ON DELETE CASCADE,
  source_connection_id UUID REFERENCES source_connections(id) ON DELETE CASCADE,
  account_id           UUID,
  feature              VARCHAR(16) NOT NULL
                         CHECK (feature IN ('mail', 'calendars', 'contacts')),
  collection_id        UUID REFERENCES integration_collections(id) ON DELETE CASCADE,
  coverage             TEXT NOT NULL DEFAULT 'default',
  cursor               TEXT,
  page_checkpoint      TEXT,
  completed_watermark  TEXT,
  running_generation   BIGINT,
  lease_expires_at     TIMESTAMPTZ,
  last_success_at      TIMESTAMPTZ,
  last_error_code      TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sync_states_account_owner_fk
    FOREIGN KEY (account_id, user_id) REFERENCES email_accounts(id, user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS sync_states_scope_key
  ON sync_states (
    user_id,
    COALESCE(connection_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(source_connection_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid),
    feature,
    COALESCE(collection_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coverage);

CREATE INDEX IF NOT EXISTS sync_states_lease_idx
  ON sync_states (running_generation, lease_expires_at);

-- ── Domain tables: allow native providers as a source ────────────────────────
-- Widen the local source checks without changing any existing value. Old code
-- only writes the previous values, which remain valid.
ALTER TABLE calendars DROP CONSTRAINT IF EXISTS calendars_source_check;
ALTER TABLE calendars ADD CONSTRAINT calendars_source_check
  CHECK (source IN ('local', 'caldav', 'ical_url', 'microsoft', 'google'));

ALTER TABLE address_books ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'local';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'address_books_source_check') THEN
    ALTER TABLE address_books ADD CONSTRAINT address_books_source_check
      CHECK (source IN ('local', 'carddav', 'ical_url', 'microsoft', 'google'));
  END IF;
END $$;
