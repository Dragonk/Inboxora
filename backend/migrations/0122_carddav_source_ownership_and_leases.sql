-- FV-01/FV-02: a CardDAV projection belongs to one exact credential source, not merely a URL.
-- Apply after 0121 and before rolling out source-owned CardDAV sync workers.
ALTER TABLE address_books
  ADD COLUMN IF NOT EXISTS source_connection_id UUID REFERENCES source_connections(id) ON DELETE CASCADE;

-- Backfill only an unambiguous pre-0122 link. Ambiguous legacy books intentionally remain
-- ownerless: application code treats them as read-only legacy data instead of guessing a credential source.
WITH unambiguous AS (
  SELECT ic.local_address_book_id AS address_book_id, min(sc.id::text)::uuid AS source_connection_id
    FROM integration_collections ic
    JOIN source_connections sc ON sc.id = ic.source_connection_id
   WHERE ic.kind = 'address_book'
     AND ic.local_address_book_id IS NOT NULL
     AND sc.integration_id IS NOT NULL
   GROUP BY ic.local_address_book_id
  HAVING count(DISTINCT sc.id) = 1
)
UPDATE address_books ab
   SET source_connection_id = u.source_connection_id
  FROM unambiguous u
 WHERE ab.id = u.address_book_id
   AND ab.source = 'carddav'
   AND ab.source_connection_id IS NULL;

-- The same remote URL is valid for two CardDAV accounts; it is unique only inside its source.
CREATE UNIQUE INDEX IF NOT EXISTS address_books_carddav_source_url_key
  ON address_books (user_id, source_connection_id, external_url)
  WHERE source = 'carddav' AND source_connection_id IS NOT NULL AND external_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS address_books_source_connection_lookup
  ON address_books (source_connection_id)
  WHERE source_connection_id IS NOT NULL;

-- A durable per-integration lease fences overlapping workers across application processes.
CREATE TABLE IF NOT EXISTS carddav_source_sync_leases (
  integration_id UUID PRIMARY KEY REFERENCES user_integrations(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS carddav_source_sync_leases_expiry_idx
  ON carddav_source_sync_leases (lease_expires_at);
