-- Apply after 0155 (and any earlier numbered migrations) before DAV lifecycle workers.
-- Source epochs invalidate snapshots fetched before a collection deletion. The
-- operation journal deliberately survives local collection cleanup: a crash after
-- dispatch must recover by read-back, never by sending another uncertain DELETE.
CREATE TABLE dav_source_fences (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('calendar', 'addressbook')),
  source_id UUID NOT NULL,
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  PRIMARY KEY (user_id, kind, source_id)
);

CREATE TABLE dav_collection_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('calendar', 'addressbook')),
  source_id UUID NOT NULL,
  local_id UUID NOT NULL,
  remote_fingerprint TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'refused', 'confirmed', 'completed')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, kind, local_id)
);
CREATE INDEX dav_collection_operations_source_idx
  ON dav_collection_operations(user_id, kind, source_id, remote_fingerprint)
  WHERE status <> 'refused';
