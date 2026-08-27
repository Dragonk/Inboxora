-- P1-06: DB-enforced tenant ownership for logical_message_id FK.
--
-- The existing 0055 migration protects conversation/account ownership via
-- composite FKs, but messages.logical_message_id is still a plain FK to
-- logical_messages(id). A message owned by user A can point to a logical
-- message owned by user B without a constraint violation — tenant isolation
-- depended solely on route authorization.
--
-- This migration adds a composite FK:
--   (logical_message_id, conversation_user_id) → logical_messages(id, user_id)
--
-- conversation_user_id is the owner marker on messages (set by 0055 and by
-- upsertConversationCopy). When logical_message_id is NULL the constraint
-- is satisfied trivially (NULL FK columns). When it is non-NULL, the
-- logical message MUST be owned by the same user who owns the message row.
--
-- Also extends conversation_evidence to use a composite FK to logical_messages
-- so evidence cannot reference another user's logical message.

-- messages → logical_messages composite tenant FK.
-- conversation_user_id is already NOT NULL when conversation_id is non-NULL
-- (chk_message_conversation_owner_present from 0055). When logical_message_id
-- is set, conversation_user_id must be set too (upsertConversationCopy always
-- sets both together). The CHECK is extended to cover logical_message_id.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS fk_message_logical_owner;
ALTER TABLE messages
  ADD CONSTRAINT fk_message_logical_owner
  FOREIGN KEY (logical_message_id, conversation_user_id)
  REFERENCES logical_messages(id, user_id)
  DEFERRABLE INITIALLY DEFERRED;

-- Strengthen the presence check: if logical_message_id is set, conversation_user_id
-- must also be set (already true in practice via upsertConversationCopy, now DB-enforced).
ALTER TABLE messages DROP CONSTRAINT IF EXISTS chk_message_logical_owner_present;
ALTER TABLE messages
  ADD CONSTRAINT chk_message_logical_owner_present
  CHECK (
    (logical_message_id IS NULL OR conversation_user_id IS NOT NULL)
    AND (conversation_id IS NULL OR conversation_user_id IS NOT NULL)
  );

-- conversation_evidence → logical_messages composite tenant FK.
-- conversation_evidence already has user_id (added in 0055). Now ensure
-- the logical_message_id points to a logical message owned by the same user.
ALTER TABLE conversation_evidence DROP CONSTRAINT IF EXISTS fk_evidence_logical_owner;
ALTER TABLE conversation_evidence
  ADD CONSTRAINT fk_evidence_logical_owner
  FOREIGN KEY (logical_message_id, user_id)
  REFERENCES logical_messages(id, user_id);

-- P1-07: unique index on (user_id, canonical_message_id, message_id_collision_key)
-- to prevent race-condition duplicates when two concurrent ingests try to
-- create the same logical message with the same collision key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_logical_messages_user_canonical_collision
  ON logical_messages(user_id, canonical_message_id, message_id_collision_key)
  WHERE canonical_message_id IS NOT NULL;
