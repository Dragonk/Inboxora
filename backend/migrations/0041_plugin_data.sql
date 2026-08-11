-- Generic per-plugin storage (v3.0 plugin platform). Keyed by (plugin_id, key); holds a JSON
-- `value`, an optional binary `blob` + mime, an optional owner (cascade-deleted with the user),
-- and a visibility flag the owning plugin uses for its own read gating. Modeled on
-- user_integrations, extended to carry blobs. The GTD inbox-zero pet is the first consumer.
CREATE TABLE IF NOT EXISTS plugin_data (
  plugin_id   VARCHAR(64)  NOT NULL,
  key         VARCHAR(255) NOT NULL,
  owner_id    UUID         REFERENCES users(id) ON DELETE CASCADE,
  value       JSONB        NOT NULL DEFAULT '{}',
  blob        BYTEA,
  blob_mime   TEXT,
  visibility  VARCHAR(16)  NOT NULL DEFAULT 'private',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (plugin_id, key)
);

-- Migrate any existing GTD pets into the generic store. No-op on installs with no pets.
-- owner_id is left NULL for migrated rows (readability still works via the plugin's
-- visibility gate); newly-imported pets set owner_id so user-delete cascades clean them up.
-- gtd_pets is intentionally kept intact for now so this change is fully reversible; a later
-- migration drops it once the plugin path is proven.
INSERT INTO plugin_data (plugin_id, key, value, blob, blob_mime, visibility, created_at, updated_at)
SELECT 'gtd',
       slug,
       jsonb_build_object('displayName', display_name, 'descriptor', descriptor),
       sheet_data,
       sheet_mime,
       CASE WHEN is_custom THEN 'private' ELSE 'public' END,
       fetched_at,
       fetched_at
FROM gtd_pets
ON CONFLICT (plugin_id, key) DO NOTHING;
