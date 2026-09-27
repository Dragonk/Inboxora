-- Shared provider-level cooldown for speculative body reads. Messages carry their
-- own attempt deadline from 0146; no historic body cache is deleted.
ALTER TABLE email_accounts ADD COLUMN body_prefetch_after TIMESTAMPTZ;
