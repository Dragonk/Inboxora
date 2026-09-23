-- FV-07: keep hydrated rule work durable until the rule engine has crossed its
-- externally-visible action boundary. This is deliberately separate from
-- provider_operations: the mail action ports retain ownership of their own journals.
ALTER TABLE provider_rule_deferred_messages
  ADD COLUMN IF NOT EXISTS dispatch_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (dispatch_state IN ('pending', 'dispatching', 'outcome_unknown', 'completed', 'refused')),
  ADD COLUMN IF NOT EXISTS action_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS action_rule_id UUID,
  ADD COLUMN IF NOT EXISTS outcome_note TEXT;

CREATE INDEX IF NOT EXISTS provider_rule_deferred_dispatch_recovery_idx
  ON provider_rule_deferred_messages (lease_expires_at, dispatch_state)
  WHERE dispatch_state IN ('dispatching', 'outcome_unknown');
