-- Logical accounts group existing DAV sources; no source or resource is recreated.
CREATE TABLE dav_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  server_url TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT,
  calendar_enabled BOOLEAN NOT NULL DEFAULT false,
  contacts_enabled BOOLEAN NOT NULL DEFAULT false,
  calendar_supported BOOLEAN NOT NULL DEFAULT false,
  contacts_supported BOOLEAN NOT NULL DEFAULT false,
  interval_min INTEGER NOT NULL DEFAULT 60 CHECK (interval_min BETWEEN 15 AND 1440),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, user_id)
);
CREATE INDEX dav_accounts_owner ON dav_accounts (user_id);
ALTER TABLE calendar_import_sources ADD COLUMN dav_account_id UUID;
ALTER TABLE calendar_import_sources ADD CONSTRAINT calendar_source_dav_owner
  FOREIGN KEY (dav_account_id, user_id) REFERENCES dav_accounts(id, user_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE user_integrations ADD COLUMN dav_account_id UUID;
ALTER TABLE user_integrations ADD CONSTRAINT contact_source_dav_owner
  FOREIGN KEY (dav_account_id, user_id) REFERENCES dav_accounts(id, user_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX calendar_import_sources_dav_account ON calendar_import_sources(dav_account_id) WHERE dav_account_id IS NOT NULL;
CREATE INDEX user_integrations_dav_account ON user_integrations(dav_account_id) WHERE dav_account_id IS NOT NULL;
