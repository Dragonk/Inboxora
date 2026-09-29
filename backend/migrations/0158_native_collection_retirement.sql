-- Apply after 0157 (when present) and all earlier migrations, before rolling out
-- native collection reconciliation. Existing migrations remain immutable.
-- Calendar tombstones now also record authoritative complete-discovery evidence.
ALTER TABLE calendar_collection_tombstones
  ADD COLUMN IF NOT EXISTS retirement_reason TEXT NOT NULL DEFAULT 'confirmed_delete'
    CHECK (retirement_reason IN ('confirmed_delete', 'complete_discovery')),
  ADD COLUMN IF NOT EXISTS discovery_generation BIGINT;

CREATE TABLE IF NOT EXISTS address_book_collection_tombstones (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL,
  remote_address_book_id TEXT NOT NULL CHECK (length(btrim(remote_address_book_id)) > 0),
  operation_id UUID REFERENCES provider_operations(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, connection_id, remote_address_book_id),
  FOREIGN KEY (connection_id, user_id)
    REFERENCES provider_connections(id, user_id) ON DELETE CASCADE
);

-- Stale event-page fencing also checks committed DELETE receipts before local
-- cleanup recovers. Bound that lookup to the exact owner/connection/remote ID.
CREATE INDEX IF NOT EXISTS provider_operations_calendar_delete_identity_idx
  ON provider_operations (user_id, connection_id, (payload->>'remoteCalendarId'))
  WHERE resource_type='calendar_collection' AND operation='delete' AND status='committed';

CREATE INDEX IF NOT EXISTS provider_operations_address_book_delete_identity_idx
  ON provider_operations (user_id, connection_id, (payload->>'remoteAddressBookId'))
  WHERE resource_type='address_book_collection' AND operation='delete' AND status='committed';
