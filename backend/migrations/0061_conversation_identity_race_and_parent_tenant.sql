-- CE v2 identity hardening.
--
-- Prevent concurrent ingestion of the same Message-ID-less physical mail from
-- creating duplicate LogicalMessages, and enforce tenant ownership of parent
-- logical-message edges at the database layer.

-- The fingerprints are deterministic only when both are available. Rows with
-- no canonical Message-ID and complete fingerprints therefore have one logical
-- identity per tenant. Partial NULL fingerprints remain intentionally outside
-- this constraint and are handled as independent identities by the planner.
CREATE UNIQUE INDEX IF NOT EXISTS uq_logical_messages_user_no_message_id_fingerprint
  ON logical_messages(user_id, body_fingerprint, header_fingerprint)
  WHERE canonical_message_id IS NULL
    AND body_fingerprint IS NOT NULL
    AND header_fingerprint IS NOT NULL;

-- A parent edge must stay inside the same tenant. logical_messages(id,user_id)
-- is unique from migration 0055, so this composite FK is fully DB-enforced.
ALTER TABLE logical_messages
  DROP CONSTRAINT IF EXISTS fk_logical_parent_owner;
ALTER TABLE logical_messages
  ADD CONSTRAINT fk_logical_parent_owner
  FOREIGN KEY (parent_logical_message_id, user_id)
  REFERENCES logical_messages(id, user_id)
  DEFERRABLE INITIALLY DEFERRED;
