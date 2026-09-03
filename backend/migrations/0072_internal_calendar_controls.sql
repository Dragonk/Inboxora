-- Account-owned calendar controls. Existing calendars use user_id as their owner;
-- backfill explicitly so the ownership contract is safe for all future queries.
ALTER TABLE calendars
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS display_visible BOOLEAN NOT NULL DEFAULT true;

UPDATE calendars SET owner_user_id = user_id WHERE owner_user_id IS NULL;

ALTER TABLE calendars
  ALTER COLUMN owner_user_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS calendars_owner_name_idx
  ON calendars (owner_user_id, name);
CREATE INDEX IF NOT EXISTS calendars_owner_idx
  ON calendars (owner_user_id, created_at);

-- calendar_events already carries calendar_id with ON DELETE CASCADE (0064), so
-- deleting an owned calendar removes its associated local events atomically.
