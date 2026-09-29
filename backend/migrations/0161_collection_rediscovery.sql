-- Apply after 0160. A discovery absence is reversible; confirmed user deletion is not.
-- Legacy address-book tombstones lack provenance and remain conservative.
ALTER TABLE calendar_collection_tombstones ADD COLUMN IF NOT EXISTS discovery_was_enabled BOOLEAN;
ALTER TABLE address_book_collection_tombstones
  ADD COLUMN IF NOT EXISTS retirement_reason TEXT NOT NULL DEFAULT 'confirmed_delete'
    CHECK (retirement_reason IN ('confirmed_delete','complete_discovery')),
  ADD COLUMN IF NOT EXISTS discovery_generation BIGINT;
