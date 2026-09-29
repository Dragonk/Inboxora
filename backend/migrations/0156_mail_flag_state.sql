-- Apply after 0155 and before deploying the durable mail flag worker.
-- Latest intent and observation obligations survive restarts. No provider writes occur in migration.
CREATE TABLE mail_flag_intents (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  flag TEXT NOT NULL CHECK (flag IN ('\Seen', '\Flagged')),
  user_id UUID NOT NULL,
  account_id UUID NOT NULL,
  generation BIGINT NOT NULL DEFAULT 1,
  value BOOLEAN NOT NULL,
  identity JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','writing','readback','confirmed','reconciled','failed')),
  code TEXT,
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, flag),
  FOREIGN KEY (account_id, user_id) REFERENCES email_accounts(id,user_id) ON DELETE CASCADE
);
CREATE INDEX mail_flag_intents_due ON mail_flag_intents(next_attempt_at) WHERE status IN ('pending','writing','readback');
CREATE TABLE mail_flag_readbacks (
  identity JSONB,
  message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  generation BIGINT NOT NULL DEFAULT 1,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_token UUID,
  lease_until TIMESTAMPTZ
);
CREATE INDEX mail_flag_readbacks_due ON mail_flag_readbacks(next_attempt_at);
ALTER TABLE messages ADD COLUMN provider_visibility_checked_at TIMESTAMPTZ;
-- Old unknown IMAP entries may lack both key and payload. Read current truth; never invent a target.
INSERT INTO mail_flag_readbacks(message_id)
SELECT DISTINCT m.id FROM provider_operations o JOIN messages m ON o.resource_id=m.id
WHERE o.resource_type='message' AND o.operation='update'
  AND o.status IN ('pending','in_flight','outcome_unknown')
  AND (o.payload->>'flag' IN ('\Seen','\Flagged') OR (o.payload IS NULL AND o.idempotency_key IS NULL))
ON CONFLICT DO NOTHING;

-- A durable delete/move intent must invalidate a visibility snapshot before its
-- provider request can start. Taking a row lock alone is insufficient: a waiting
-- READ COMMITTED SELECT could otherwise keep its earlier journal snapshot. The
-- no-op UPDATE advances xmin, which current-provider recovery explicitly fences.
CREATE FUNCTION fence_mail_visibility_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE messages m SET provider_visibility_checked_at=m.provider_visibility_checked_at
  FROM email_accounts a
  WHERE m.id=NEW.resource_id AND m.account_id=NEW.account_id
    AND a.id=m.account_id AND a.user_id=NEW.user_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER provider_operations_mail_visibility_fence
BEFORE INSERT ON provider_operations
FOR EACH ROW WHEN (NEW.resource_type='message' AND
  (NEW.operation='delete' OR NEW.payload ?| ARRAY['destinationFolderId','addLabelIds','removeLabelIds']
   OR NEW.idempotency_key LIKE '%mail-move:%' OR NEW.idempotency_key LIKE '%mail-delete:%'))
EXECUTE FUNCTION fence_mail_visibility_intent();
