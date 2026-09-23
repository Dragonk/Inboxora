-- SVC-01: account-scoped service intent is distinct from provider scopes and discovered collections.
-- Apply after 0126. New accounts default to no optional provider feature enabled.
CREATE TABLE IF NOT EXISTS account_provider_feature_settings (
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  feature TEXT NOT NULL CHECK (feature IN ('calendars', 'contacts')),
  enabled BOOLEAN NOT NULL DEFAULT false,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, feature)
);

-- Preserve services that an existing installation was actively using; do not infer new
-- intent merely from a broad OAuth grant. Accounts without an enabled linked projection
-- remain disabled until their owner explicitly enables the service.
INSERT INTO account_provider_feature_settings (account_id, feature, enabled)
SELECT a.id, feature.feature, true
FROM email_accounts a
JOIN LATERAL (VALUES ('calendars'), ('contacts')) AS feature(feature) ON true
WHERE a.provider_connection_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM integration_collections ic
    WHERE ic.user_id = a.user_id
      AND ic.enabled = true
      AND (ic.connection_id = a.provider_connection_id OR ic.source_connection_id = a.provider_connection_id)
      AND ((feature.feature = 'calendars' AND ic.kind = 'calendar')
        OR (feature.feature = 'contacts' AND ic.kind = 'address_book'))
  )
ON CONFLICT (account_id, feature) DO NOTHING;
