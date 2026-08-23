-- Tenant-scoped integrity constraints for Conversation Engine v2.
ALTER TABLE conversations ADD CONSTRAINT uq_conversations_id_user UNIQUE (id, user_id);
ALTER TABLE logical_messages ADD CONSTRAINT uq_logical_messages_id_user UNIQUE (id, user_id);
ALTER TABLE email_accounts ADD CONSTRAINT uq_email_accounts_id_user UNIQUE (id, user_id);

ALTER TABLE logical_messages
  ADD CONSTRAINT fk_logical_conversation_owner
  FOREIGN KEY (conversation_id, user_id) REFERENCES conversations(id, user_id);
ALTER TABLE provider_thread_mappings
  ADD CONSTRAINT fk_provider_mapping_account_owner
  FOREIGN KEY (account_id, user_id) REFERENCES email_accounts(id, user_id),
  ADD CONSTRAINT fk_provider_mapping_conversation_owner
  FOREIGN KEY (conversation_id, user_id) REFERENCES conversations(id, user_id);
ALTER TABLE conversation_aliases
  ADD CONSTRAINT fk_alias_owner
  FOREIGN KEY (alias_conversation_id, user_id) REFERENCES conversations(id, user_id),
  ADD CONSTRAINT fk_alias_canonical_owner
  FOREIGN KEY (canonical_conversation_id, user_id) REFERENCES conversations(id, user_id);
ALTER TABLE conversation_evidence
  ADD COLUMN IF NOT EXISTS user_id UUID;
UPDATE conversation_evidence e SET user_id = c.user_id FROM conversations c WHERE c.id = e.conversation_id AND e.user_id IS NULL;
ALTER TABLE conversation_evidence ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE conversation_evidence ADD CONSTRAINT fk_evidence_conversation_owner FOREIGN KEY (conversation_id, user_id) REFERENCES conversations(id, user_id);
ALTER TABLE conversation_overrides
  ADD CONSTRAINT fk_override_conversation_owner FOREIGN KEY (conversation_id, user_id) REFERENCES conversations(id, user_id),
  ADD CONSTRAINT fk_override_logical_owner FOREIGN KEY (logical_message_id, user_id) REFERENCES logical_messages(id, user_id);
ALTER TABLE unresolved_message_references
  ADD CONSTRAINT fk_unresolved_child_owner FOREIGN KEY (child_logical_message_id, user_id) REFERENCES logical_messages(id, user_id),
  ADD CONSTRAINT fk_unresolved_resolved_owner FOREIGN KEY (resolved_logical_message_id, user_id) REFERENCES logical_messages(id, user_id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_user_id UUID;
UPDATE messages m SET conversation_user_id = c.user_id FROM conversations c WHERE c.id = m.conversation_id AND m.conversation_user_id IS NULL;
ALTER TABLE messages ADD CONSTRAINT chk_message_conversation_owner_present CHECK (conversation_id IS NULL OR conversation_user_id IS NOT NULL);
ALTER TABLE messages ADD CONSTRAINT fk_message_conversation_owner FOREIGN KEY (conversation_id, conversation_user_id) REFERENCES conversations(id, user_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE messages ADD CONSTRAINT fk_message_account_conversation_owner FOREIGN KEY (account_id, conversation_user_id) REFERENCES email_accounts(id, user_id) DEFERRABLE INITIALLY DEFERRED;
