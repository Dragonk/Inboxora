-- Conversation automation series policy. OFF is the safe default.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS automated_series_mode TEXT NOT NULL DEFAULT 'off';
ALTER TABLE email_accounts ADD CONSTRAINT email_accounts_automated_series_mode_check
  CHECK (automated_series_mode IN ('off', 'strict', 'smart'));
ALTER TABLE messages ADD COLUMN IF NOT EXISTS automated_series_mode TEXT;
