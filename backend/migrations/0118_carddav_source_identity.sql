-- RV-01/RV-02: bind external CardDAV collections to the exact user integration
-- that supplied their credentials. The old URL-only identity is ambiguous when a
-- user connects two accounts on the same server.
ALTER TABLE source_connections
  ADD COLUMN IF NOT EXISTS integration_id UUID REFERENCES user_integrations(id) ON DELETE CASCADE;

DROP INDEX IF EXISTS source_connections_url_key;
CREATE UNIQUE INDEX IF NOT EXISTS source_connections_integration_key
  ON source_connections (user_id, kind, integration_id)
  WHERE integration_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS source_connections_legacy_url_key
  ON source_connections (user_id, url_fingerprint)
  WHERE url_fingerprint IS NOT NULL AND integration_id IS NULL;

CREATE INDEX IF NOT EXISTS source_connections_integration_lookup
  ON source_connections (integration_id)
  WHERE integration_id IS NOT NULL;
