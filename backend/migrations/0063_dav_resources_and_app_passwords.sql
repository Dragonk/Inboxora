-- Local DAV foundation: each MailFlow account owns a Personal contacts book and
-- calendar. Device credentials are separate from primary login credentials.

CREATE TABLE IF NOT EXISTS calendars (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT 'Personal',
  description  TEXT,
  color        TEXT,
  source       TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'caldav', 'ical_url')),
  external_url TEXT,
  read_only    BOOLEAN NOT NULL DEFAULT false,
  sync_token   TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS dav_app_passwords (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  token_prefix   TEXT NOT NULL,
  secret_hash    TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  UNIQUE (user_id, token_prefix)
);

CREATE INDEX IF NOT EXISTS dav_app_passwords_active_lookup_idx
  ON dav_app_passwords (user_id, token_prefix)
  WHERE revoked_at IS NULL;

-- Existing users receive resources before application code starts enforcing the
-- invariant for future local and OIDC-provisioned accounts.
INSERT INTO address_books (user_id, name, source)
SELECT id, 'Personal', 'local' FROM users
ON CONFLICT (user_id, name) DO NOTHING;

INSERT INTO calendars (user_id, name, source, read_only)
SELECT id, 'Personal', 'local', false FROM users
ON CONFLICT (user_id, name) DO NOTHING;
