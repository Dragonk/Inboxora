-- Expand the conversation_overrides.override_type CHECK to cover all 7 supported types.
-- The original migration (0051) only knew 5 values; the code also supports
-- 'unlock-conversation' and 'manual-move', which the DB constraint rejected with
-- a 23514 violation instead of a clean application-level error.
--
-- Also adds target_user_id for tenant-safe ownership of target_id (P1-04):
-- target_id points to conversations(id), so it must be tenant-scoped via a
-- composite FK (target_id, target_user_id) → conversations(id, user_id).
-- Backfills target_user_id = user_id for existing rows with non-null target_id.
--
-- Do NOT assume the old constraint name — Postgres auto-generates it.
-- Drop by matching on contype='c' + the table, then create an explicitly named one.

DO $$
DECLARE
  old_constraint_name TEXT;
BEGIN
  SELECT conname INTO old_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'conversation_overrides'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%override_type%';
  IF old_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE conversation_overrides DROP CONSTRAINT %I', old_constraint_name);
  END IF;
END $$;

ALTER TABLE conversation_overrides
  ADD CONSTRAINT conversation_overrides_override_type_check
  CHECK (override_type IN (
    'force-include',
    'force-exclude',
    'manual-split',
    'manual-merge',
    'lock-conversation',
    'unlock-conversation',
    'manual-move'
  ));

-- target_user_id: tenant-safe ownership for target_id (P1-04).
ALTER TABLE conversation_overrides ADD COLUMN IF NOT EXISTS target_user_id UUID;

-- Backfill: for existing rows with non-null target_id, set target_user_id = user_id.
-- The target_id is a conversation UUID, and the user who created the override
-- owns the target (validated at application level so far; now enforced by FK).
UPDATE conversation_overrides
  SET target_user_id = user_id
  WHERE target_id IS NOT NULL AND target_user_id IS NULL;

-- CHECK: target_id and target_user_id must both be NULL or both non-NULL.
ALTER TABLE conversation_overrides
  ADD CONSTRAINT chk_override_target_owner_present
  CHECK (target_id IS NULL = target_user_id IS NULL);

-- Composite FK: (target_id, target_user_id) → conversations(id, user_id).
-- DEFERRABLE INITIALLY DEFERRED so manual-move/merge can reorder within a
-- transaction before the FK is checked at COMMIT.
ALTER TABLE conversation_overrides
  DROP CONSTRAINT IF EXISTS fk_override_target_owner;
ALTER TABLE conversation_overrides
  ADD CONSTRAINT fk_override_target_owner
  FOREIGN KEY (target_id, target_user_id)
  REFERENCES conversations(id, user_id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

-- When target is deleted, also null out target_user_id (ON DELETE SET NULL
-- only nulls the FK columns; we need a trigger to keep the CHECK invariant).
CREATE OR REPLACE FUNCTION null_override_target_user_id()
RETURNS TRIGGER AS $$
BEGIN
  NEW.target_user_id := CASE WHEN NEW.target_id IS NULL THEN NULL ELSE NEW.target_user_id END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_override_target_user_id ON conversation_overrides;
CREATE TRIGGER trg_override_target_user_id
  BEFORE INSERT OR UPDATE ON conversation_overrides
  FOR EACH ROW EXECUTE FUNCTION null_override_target_user_id();
