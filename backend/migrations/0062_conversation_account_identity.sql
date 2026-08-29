-- Conversation Engine identities are local to one managed email account.
-- Split historic user-wide LogicalMessages/Conversations before installing the
-- account-composite integrity model.  The migration runner wraps this file in a
-- transaction, so either the complete graph is remapped or none of it is.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS account_id UUID;
ALTER TABLE logical_messages ADD COLUMN IF NOT EXISTS account_id UUID;
ALTER TABLE unresolved_message_references ADD COLUMN IF NOT EXISTS account_id UUID;
ALTER TABLE conversation_aliases ADD COLUMN IF NOT EXISTS account_id UUID;
ALTER TABLE conversation_evidence ADD COLUMN IF NOT EXISTS account_id UUID;
ALTER TABLE conversation_overrides ADD COLUMN IF NOT EXISTS account_id UUID;

-- Remove user-wide identity constraints before cloning cross-account rows.
DROP INDEX IF EXISTS uq_logical_messages_user_canonical_collision;
DROP INDEX IF EXISTS uq_logical_messages_user_no_message_id_fingerprint;

-- Temporarily remove CE ownership/reference constraints. They are replaced by
-- stronger (user_id, account_id) constraints after the graph has been split.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_logical_message_id_fkey;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_conversation_id_fkey;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS fk_message_logical_owner;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS fk_message_conversation_owner;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS fk_message_account_conversation_owner;
ALTER TABLE logical_messages DROP CONSTRAINT IF EXISTS logical_messages_conversation_id_fkey;
ALTER TABLE logical_messages DROP CONSTRAINT IF EXISTS logical_messages_parent_logical_message_id_fkey;
ALTER TABLE logical_messages DROP CONSTRAINT IF EXISTS fk_logical_conversation_owner;
ALTER TABLE logical_messages DROP CONSTRAINT IF EXISTS fk_logical_parent_owner;
ALTER TABLE provider_thread_mappings DROP CONSTRAINT IF EXISTS provider_thread_mappings_conversation_id_fkey;
ALTER TABLE provider_thread_mappings DROP CONSTRAINT IF EXISTS fk_provider_mapping_conversation_owner;
ALTER TABLE unresolved_message_references DROP CONSTRAINT IF EXISTS unresolved_message_references_child_logical_message_id_fkey;
ALTER TABLE unresolved_message_references DROP CONSTRAINT IF EXISTS unresolved_message_references_resolved_logical_message_id_fkey;
ALTER TABLE unresolved_message_references DROP CONSTRAINT IF EXISTS fk_unresolved_child_owner;
ALTER TABLE unresolved_message_references DROP CONSTRAINT IF EXISTS fk_unresolved_resolved_owner;
ALTER TABLE conversation_aliases DROP CONSTRAINT IF EXISTS conversation_aliases_canonical_conversation_id_fkey;
ALTER TABLE conversation_aliases DROP CONSTRAINT IF EXISTS fk_alias_owner;
ALTER TABLE conversation_aliases DROP CONSTRAINT IF EXISTS fk_alias_canonical_owner;
ALTER TABLE conversation_evidence DROP CONSTRAINT IF EXISTS conversation_evidence_conversation_id_fkey;
ALTER TABLE conversation_evidence DROP CONSTRAINT IF EXISTS conversation_evidence_logical_message_id_fkey;
ALTER TABLE conversation_evidence DROP CONSTRAINT IF EXISTS fk_evidence_conversation_owner;
ALTER TABLE conversation_evidence DROP CONSTRAINT IF EXISTS fk_evidence_logical_owner;
ALTER TABLE conversation_overrides DROP CONSTRAINT IF EXISTS conversation_overrides_conversation_id_fkey;
ALTER TABLE conversation_overrides DROP CONSTRAINT IF EXISTS conversation_overrides_logical_message_id_fkey;
ALTER TABLE conversation_overrides DROP CONSTRAINT IF EXISTS fk_override_conversation_owner;
ALTER TABLE conversation_overrides DROP CONSTRAINT IF EXISTS fk_override_logical_owner;
ALTER TABLE conversation_overrides DROP CONSTRAINT IF EXISTS fk_override_target_owner;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_continued_from_conversation_id_fkey;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_continued_to_conversation_id_fkey;

CREATE TEMP TABLE ce_lm_pairs ON COMMIT DROP AS
SELECT DISTINCT lm.id AS old_id, lm.user_id, m.account_id
  FROM logical_messages lm
  JOIN messages m ON m.logical_message_id = lm.id
  JOIN email_accounts a ON a.id = m.account_id AND a.user_id = lm.user_id;

-- Logical rows without a physical copy inherit their conversation's sole known
-- account when possible, otherwise the owner's oldest account. This preserves
-- detached/manual state without inventing cross-account links.
INSERT INTO ce_lm_pairs (old_id, user_id, account_id)
SELECT lm.id, lm.user_id,
       COALESCE((SELECT MIN(p.account_id::text)::uuid FROM ce_lm_pairs p
                  JOIN logical_messages sibling ON sibling.id = p.old_id
                 WHERE sibling.conversation_id = lm.conversation_id),
                (SELECT MIN(a.id::text)::uuid FROM email_accounts a WHERE a.user_id = lm.user_id))
  FROM logical_messages lm
 WHERE NOT EXISTS (SELECT 1 FROM ce_lm_pairs p WHERE p.old_id = lm.id)
   AND EXISTS (SELECT 1 FROM email_accounts a WHERE a.user_id = lm.user_id);

CREATE TEMP TABLE ce_conv_pairs ON COMMIT DROP AS
SELECT DISTINCT c.id AS old_id, c.user_id, p.account_id
  FROM conversations c
  JOIN logical_messages lm ON lm.conversation_id = c.id
  JOIN ce_lm_pairs p ON p.old_id = lm.id
UNION
SELECT c.id, c.user_id, p.account_id
  FROM conversations c
  JOIN provider_thread_mappings p ON p.conversation_id = c.id AND p.user_id = c.user_id
UNION
SELECT c.id, c.user_id, a.id
  FROM conversations c
  JOIN LATERAL (
    SELECT MIN(ea.id::text)::uuid AS id FROM email_accounts ea WHERE ea.user_id = c.user_id
  ) a ON a.id IS NOT NULL
 WHERE NOT EXISTS (
   SELECT 1 FROM logical_messages lm JOIN ce_lm_pairs p ON p.old_id = lm.id
    WHERE lm.conversation_id = c.id
 )
   AND NOT EXISTS (SELECT 1 FROM provider_thread_mappings p WHERE p.conversation_id = c.id AND p.user_id = c.user_id);

-- Pre-account CE could retain orphan graphs after a user's final account was removed.
-- They cannot be assigned a truthful account identity, so purge only graphs with no
-- physical/provider/account evidence before enforcing the account boundary.
DELETE FROM logical_messages lm
 WHERE NOT EXISTS (SELECT 1 FROM ce_lm_pairs p WHERE p.old_id = lm.id);
DELETE FROM conversations c
 WHERE NOT EXISTS (SELECT 1 FROM ce_conv_pairs p WHERE p.old_id = c.id);

CREATE TEMP TABLE ce_old_conversations ON COMMIT DROP AS SELECT * FROM conversations;
CREATE TEMP TABLE ce_old_logical_messages ON COMMIT DROP AS SELECT * FROM logical_messages;

CREATE TEMP TABLE ce_conv_map ON COMMIT DROP AS
SELECT old_id, user_id, account_id,
       CASE WHEN row_number() OVER (PARTITION BY old_id ORDER BY account_id) = 1
            THEN old_id ELSE gen_random_uuid() END AS new_id
  FROM ce_conv_pairs;
CREATE UNIQUE INDEX ON ce_conv_map(old_id, account_id);
CREATE UNIQUE INDEX ON ce_conv_map(new_id);

CREATE TEMP TABLE ce_lm_map ON COMMIT DROP AS
SELECT p.old_id, p.user_id, p.account_id,
       CASE WHEN row_number() OVER (PARTITION BY p.old_id ORDER BY p.account_id) = 1
            THEN p.old_id ELSE gen_random_uuid() END AS new_id
  FROM ce_lm_pairs p;
CREATE UNIQUE INDEX ON ce_lm_map(old_id, account_id);
CREATE UNIQUE INDEX ON ce_lm_map(new_id);

-- Snapshot dependent state before remapping/recreating it.
CREATE TEMP TABLE ce_old_unresolved ON COMMIT DROP AS SELECT * FROM unresolved_message_references;
CREATE TEMP TABLE ce_old_aliases ON COMMIT DROP AS SELECT * FROM conversation_aliases;
CREATE TEMP TABLE ce_old_evidence ON COMMIT DROP AS SELECT * FROM conversation_evidence;
CREATE TEMP TABLE ce_old_overrides ON COMMIT DROP AS SELECT * FROM conversation_overrides;
TRUNCATE unresolved_message_references, conversation_aliases, conversation_evidence, conversation_overrides;

-- Clone conversations for every account represented by the historic container.
INSERT INTO conversations (
  id, user_id, account_id, kind, subject_snapshot, canonical_subject,
  first_message_at, last_message_at, logical_message_count, copy_count,
  unread_count, algorithm_version, threading_confidence, manually_locked,
  continued_from_conversation_id, continued_to_conversation_id, segment_number,
  created_at, updated_at
)
SELECT map.new_id, c.user_id, map.account_id, c.kind, c.subject_snapshot,
       c.canonical_subject, c.first_message_at, c.last_message_at,
       c.logical_message_count, c.copy_count, c.unread_count,
       c.algorithm_version, c.threading_confidence, c.manually_locked,
       NULL, NULL, c.segment_number, c.created_at, c.updated_at
  FROM conversations c
  JOIN ce_conv_map map ON map.old_id = c.id
 WHERE map.new_id <> c.id;

UPDATE conversations c
   SET account_id = map.account_id,
       continued_from_conversation_id = NULL,
       continued_to_conversation_id = NULL
  FROM ce_conv_map map
 WHERE map.old_id = c.id AND map.new_id = c.id;

-- Clone LogicalMessages account-locally. Parent edges are restored only when
-- both endpoints exist in the same account.
INSERT INTO logical_messages (
  id, user_id, account_id, conversation_id, canonical_message_id,
  raw_message_id, message_id_collision_key, parent_logical_message_id,
  raw_in_reply_to, raw_references, parsed_in_reply_to, parsed_references,
  subject, canonical_subject, from_address, sender_address,
  recipient_signature, sender_signature, direction, message_date, received_at,
  first_seen_at, body_fingerprint, header_fingerprint, threading_reason,
  threading_confidence, algorithm_version, diagnostics, created_at, updated_at,
  raw_headers
)
SELECT map.new_id, lm.user_id, map.account_id, conv.new_id,
       lm.canonical_message_id, lm.raw_message_id, lm.message_id_collision_key,
       NULL, lm.raw_in_reply_to, lm.raw_references, lm.parsed_in_reply_to,
       lm.parsed_references, lm.subject, lm.canonical_subject, lm.from_address,
       lm.sender_address, lm.recipient_signature, lm.sender_signature,
       lm.direction, lm.message_date, lm.received_at, lm.first_seen_at,
       lm.body_fingerprint, lm.header_fingerprint, lm.threading_reason,
       lm.threading_confidence, lm.algorithm_version, lm.diagnostics,
       lm.created_at, lm.updated_at, lm.raw_headers
  FROM logical_messages lm
  JOIN ce_lm_map map ON map.old_id = lm.id
  LEFT JOIN ce_conv_map conv
    ON conv.old_id = lm.conversation_id AND conv.account_id = map.account_id
 WHERE map.new_id <> lm.id;

UPDATE logical_messages lm
   SET account_id = mapped.account_id,
       conversation_id = mapped.conversation_id,
       parent_logical_message_id = NULL
  FROM (
    SELECT map.old_id, map.new_id, map.account_id, conv.new_id AS conversation_id
      FROM ce_lm_map map
      JOIN ce_old_logical_messages old_lm ON old_lm.id = map.old_id
      LEFT JOIN ce_conv_map conv
        ON conv.old_id = old_lm.conversation_id AND conv.account_id = map.account_id
  ) mapped
 WHERE mapped.old_id = lm.id AND mapped.new_id = lm.id;

UPDATE logical_messages child
   SET parent_logical_message_id = parent_map.new_id
  FROM ce_lm_map child_map
  JOIN ce_old_logical_messages old_child ON old_child.id = child_map.old_id
  JOIN ce_lm_map parent_map
    ON parent_map.old_id = old_child.parent_logical_message_id
   AND parent_map.account_id = child_map.account_id
 WHERE child.id = child_map.new_id;

UPDATE messages m
   SET logical_message_id = mapped.logical_message_id,
       conversation_id = mapped.conversation_id,
       conversation_user_id = mapped.user_id
  FROM (
    SELECT source.id, a.user_id, lm_map.new_id AS logical_message_id,
           conv_map.new_id AS conversation_id
      FROM messages source
      JOIN email_accounts a ON a.id = source.account_id
      LEFT JOIN ce_lm_map lm_map
        ON lm_map.old_id = source.logical_message_id AND lm_map.account_id = a.id
      LEFT JOIN ce_conv_map conv_map
        ON conv_map.old_id = source.conversation_id AND conv_map.account_id = a.id
     WHERE source.logical_message_id IS NOT NULL OR source.conversation_id IS NOT NULL
  ) mapped
 WHERE mapped.id = m.id;

-- Restore continuation links only inside the same account.
UPDATE conversations c
   SET continued_from_conversation_id = from_map.new_id,
       continued_to_conversation_id = to_map.new_id
  FROM ce_conv_map self_map
  JOIN ce_old_conversations old_c ON old_c.id = self_map.old_id
  LEFT JOIN ce_conv_map from_map ON from_map.old_id = old_c.continued_from_conversation_id AND from_map.account_id = self_map.account_id
  LEFT JOIN ce_conv_map to_map ON to_map.old_id = old_c.continued_to_conversation_id AND to_map.account_id = self_map.account_id
 WHERE c.id = self_map.new_id;

UPDATE provider_thread_mappings p
   SET conversation_id = map.new_id
  FROM ce_conv_map map
 WHERE map.old_id = p.conversation_id AND map.account_id = p.account_id;

INSERT INTO unresolved_message_references (
  id, user_id, account_id, child_logical_message_id, referenced_message_id,
  relation_type, reference_position, resolved_logical_message_id, resolved_at,
  created_at
)
SELECT CASE WHEN row_number() OVER (PARTITION BY old.id ORDER BY child.account_id) = 1 THEN old.id ELSE gen_random_uuid() END,
       old.user_id, child.account_id, child.new_id, old.referenced_message_id,
       old.relation_type, old.reference_position, resolved.new_id,
       CASE WHEN resolved.new_id IS NULL THEN NULL ELSE old.resolved_at END,
       old.created_at
  FROM ce_old_unresolved old
  JOIN ce_lm_map child ON child.old_id = old.child_logical_message_id
  LEFT JOIN ce_lm_map resolved
    ON resolved.old_id = old.resolved_logical_message_id
   AND resolved.account_id = child.account_id;

INSERT INTO conversation_aliases (
  user_id, account_id, alias_conversation_id, canonical_conversation_id,
  reason, created_at
)
SELECT old.user_id, alias.account_id, alias.new_id, canonical.new_id,
       old.reason, old.created_at
  FROM ce_old_aliases old
  JOIN ce_conv_map alias ON alias.old_id = old.alias_conversation_id
  JOIN ce_conv_map canonical
    ON canonical.old_id = old.canonical_conversation_id
   AND canonical.account_id = alias.account_id;

INSERT INTO conversation_evidence (
  id, user_id, account_id, conversation_id, logical_message_id,
  evidence_type, evidence_value_hash, weight, algorithm_version, details,
  created_at
)
SELECT CASE WHEN row_number() OVER (PARTITION BY old.id ORDER BY conv.account_id) = 1 THEN old.id ELSE gen_random_uuid() END,
       old.user_id, conv.account_id, conv.new_id, lm.new_id,
       old.evidence_type, old.evidence_value_hash, old.weight,
       old.algorithm_version, old.details, old.created_at
  FROM ce_old_evidence old
  JOIN ce_conv_map conv ON conv.old_id = old.conversation_id
  LEFT JOIN ce_lm_map lm
    ON lm.old_id = old.logical_message_id AND lm.account_id = conv.account_id
 WHERE old.logical_message_id IS NULL OR lm.new_id IS NOT NULL;

INSERT INTO conversation_overrides (
  id, user_id, account_id, conversation_id, logical_message_id,
  override_type, target_id, target_user_id, reason, created_at
)
SELECT CASE WHEN row_number() OVER (PARTITION BY old.id ORDER BY scope.account_id) = 1 THEN old.id ELSE gen_random_uuid() END,
       old.user_id, scope.account_id, conv.new_id, lm.new_id,
       old.override_type, target.new_id,
       CASE WHEN target.new_id IS NULL THEN NULL ELSE old.user_id END,
       CASE
         WHEN old.target_id IS NOT NULL AND target.new_id IS NULL THEN
           concat_ws(' ', old.reason, '[0062: cross-account target removed; original target=', old.target_id::text, ']')
         ELSE old.reason
       END,
       old.created_at
  FROM ce_old_overrides old
  JOIN LATERAL (
    SELECT account_id FROM ce_lm_map WHERE old_id = old.logical_message_id
    UNION
    SELECT account_id FROM ce_conv_map WHERE old_id = old.conversation_id AND old.logical_message_id IS NULL
  ) scope ON TRUE
  LEFT JOIN ce_conv_map conv
    ON conv.old_id = old.conversation_id AND conv.account_id = scope.account_id
  LEFT JOIN ce_lm_map lm
    ON lm.old_id = old.logical_message_id AND lm.account_id = scope.account_id
  LEFT JOIN ce_conv_map target
    ON target.old_id = old.target_id AND target.account_id = scope.account_id;

-- Recalculate account-local aggregates after the split.
UPDATE conversations c SET
  first_message_at = (SELECT MIN(message_date) FROM logical_messages lm WHERE lm.conversation_id = c.id AND lm.account_id = c.account_id),
  last_message_at = (SELECT MAX(message_date) FROM logical_messages lm WHERE lm.conversation_id = c.id AND lm.account_id = c.account_id),
  logical_message_count = (SELECT COUNT(*) FROM logical_messages lm WHERE lm.conversation_id = c.id AND lm.account_id = c.account_id),
  copy_count = (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.account_id = c.account_id AND m.is_deleted = false),
  unread_count = (SELECT COUNT(*) FROM logical_messages lm WHERE lm.conversation_id = c.id AND lm.account_id = c.account_id AND EXISTS (
    SELECT 1 FROM messages m WHERE m.logical_message_id = lm.id AND m.account_id = c.account_id AND m.is_deleted = false AND m.is_read = false
  )),
  updated_at = NOW();

ALTER TABLE conversations ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE logical_messages ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE unresolved_message_references ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE conversation_aliases ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE conversation_evidence ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE conversation_overrides ALTER COLUMN account_id SET NOT NULL;

ALTER TABLE conversations ADD CONSTRAINT uq_conversations_id_user_account UNIQUE (id, user_id, account_id);
ALTER TABLE logical_messages ADD CONSTRAINT uq_logical_messages_id_user_account UNIQUE (id, user_id, account_id);

ALTER TABLE conversations ADD CONSTRAINT fk_conversation_account_owner FOREIGN KEY (account_id, user_id) REFERENCES email_accounts(id, user_id) ON DELETE CASCADE;
ALTER TABLE logical_messages ADD CONSTRAINT fk_logical_account_owner FOREIGN KEY (account_id, user_id) REFERENCES email_accounts(id, user_id) ON DELETE CASCADE;
ALTER TABLE logical_messages ADD CONSTRAINT fk_logical_conversation_account FOREIGN KEY (conversation_id, user_id, account_id) REFERENCES conversations(id, user_id, account_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE logical_messages ADD CONSTRAINT fk_logical_parent_account FOREIGN KEY (parent_logical_message_id, user_id, account_id) REFERENCES logical_messages(id, user_id, account_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE conversations ADD CONSTRAINT fk_conversation_continued_from_account FOREIGN KEY (continued_from_conversation_id, user_id, account_id) REFERENCES conversations(id, user_id, account_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE conversations ADD CONSTRAINT fk_conversation_continued_to_account FOREIGN KEY (continued_to_conversation_id, user_id, account_id) REFERENCES conversations(id, user_id, account_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE provider_thread_mappings ADD CONSTRAINT fk_provider_mapping_conversation_account FOREIGN KEY (conversation_id, user_id, account_id) REFERENCES conversations(id, user_id, account_id);
ALTER TABLE unresolved_message_references ADD CONSTRAINT fk_unresolved_account_owner FOREIGN KEY (account_id, user_id) REFERENCES email_accounts(id, user_id) ON DELETE CASCADE;
ALTER TABLE unresolved_message_references ADD CONSTRAINT fk_unresolved_child_account FOREIGN KEY (child_logical_message_id, user_id, account_id) REFERENCES logical_messages(id, user_id, account_id) ON DELETE CASCADE;
ALTER TABLE unresolved_message_references ADD CONSTRAINT fk_unresolved_resolved_account FOREIGN KEY (resolved_logical_message_id, user_id, account_id) REFERENCES logical_messages(id, user_id, account_id) ON DELETE SET NULL (resolved_logical_message_id);
ALTER TABLE conversation_aliases ADD CONSTRAINT fk_alias_account_owner FOREIGN KEY (account_id, user_id) REFERENCES email_accounts(id, user_id) ON DELETE CASCADE;
ALTER TABLE conversation_aliases ADD CONSTRAINT fk_alias_source_account FOREIGN KEY (alias_conversation_id, user_id, account_id) REFERENCES conversations(id, user_id, account_id);
ALTER TABLE conversation_aliases ADD CONSTRAINT fk_alias_canonical_account FOREIGN KEY (canonical_conversation_id, user_id, account_id) REFERENCES conversations(id, user_id, account_id) ON DELETE CASCADE;
ALTER TABLE conversation_evidence ADD CONSTRAINT fk_evidence_account_owner FOREIGN KEY (account_id, user_id) REFERENCES email_accounts(id, user_id) ON DELETE CASCADE;
ALTER TABLE conversation_evidence ADD CONSTRAINT fk_evidence_conversation_account FOREIGN KEY (conversation_id, user_id, account_id) REFERENCES conversations(id, user_id, account_id) ON DELETE CASCADE;
ALTER TABLE conversation_evidence ADD CONSTRAINT fk_evidence_logical_account FOREIGN KEY (logical_message_id, user_id, account_id) REFERENCES logical_messages(id, user_id, account_id) ON DELETE CASCADE;
ALTER TABLE conversation_overrides ADD CONSTRAINT fk_override_account_owner FOREIGN KEY (account_id, user_id) REFERENCES email_accounts(id, user_id) ON DELETE CASCADE;
ALTER TABLE conversation_overrides ADD CONSTRAINT fk_override_conversation_account FOREIGN KEY (conversation_id, user_id, account_id) REFERENCES conversations(id, user_id, account_id) ON DELETE CASCADE;
ALTER TABLE conversation_overrides ADD CONSTRAINT fk_override_logical_account FOREIGN KEY (logical_message_id, user_id, account_id) REFERENCES logical_messages(id, user_id, account_id) ON DELETE CASCADE;
-- PostgreSQL MATCH SIMPLE would skip account validation when target_id is NULL;
-- when a target exists, the account is the override row's own account.
ALTER TABLE conversation_overrides ADD CONSTRAINT chk_override_target_account_present CHECK (target_id IS NULL OR account_id IS NOT NULL);
ALTER TABLE conversation_overrides ADD CONSTRAINT fk_override_target_account FOREIGN KEY (target_id, target_user_id, account_id) REFERENCES conversations(id, user_id, account_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE messages ADD CONSTRAINT fk_message_logical_account FOREIGN KEY (logical_message_id, conversation_user_id, account_id) REFERENCES logical_messages(id, user_id, account_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE messages ADD CONSTRAINT fk_message_conversation_account FOREIGN KEY (conversation_id, conversation_user_id, account_id) REFERENCES conversations(id, user_id, account_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE conversation_aliases DROP CONSTRAINT IF EXISTS conversation_aliases_pkey;
ALTER TABLE conversation_aliases ADD PRIMARY KEY (user_id, account_id, alias_conversation_id);
ALTER TABLE unresolved_message_references DROP CONSTRAINT IF EXISTS unresolved_message_references_user_id_child_logical_message_id_ref_key;
ALTER TABLE unresolved_message_references ADD CONSTRAINT uq_unresolved_account_reference UNIQUE (user_id, account_id, child_logical_message_id, referenced_message_id, relation_type, reference_position);

CREATE UNIQUE INDEX uq_logical_messages_account_canonical_collision
  ON logical_messages(user_id, account_id, canonical_message_id, message_id_collision_key)
  WHERE canonical_message_id IS NOT NULL;
CREATE UNIQUE INDEX uq_logical_messages_account_no_message_id_fingerprint
  ON logical_messages(user_id, account_id, body_fingerprint, header_fingerprint)
  WHERE canonical_message_id IS NULL AND body_fingerprint IS NOT NULL AND header_fingerprint IS NOT NULL;
CREATE INDEX idx_conversations_user_account_latest ON conversations(user_id, account_id, last_message_at DESC, id);
CREATE INDEX idx_logical_messages_user_account_message ON logical_messages(user_id, account_id, canonical_message_id);
