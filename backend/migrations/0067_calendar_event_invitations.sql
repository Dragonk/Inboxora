ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS attendees JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS invite_account_id UUID REFERENCES email_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS invitation_sequence INTEGER NOT NULL DEFAULT 0 CHECK (invitation_sequence >= 0);