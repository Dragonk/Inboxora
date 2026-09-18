-- Antispam ML classifier (v0.2): per-user Naive Bayes model, mark-time training
-- features, per-account opt-in, GDPR deletion audit, trusted authserv-id.
-- Apply before deploying the spam classifier code.
--
-- Design: hybrid rules (always on) + multinomial Naive Bayes (active at
-- >= 50 training records), vocabulary capped via chi-square pruning.
-- Training features are persisted at mark time (Solution C): the retrain
-- path reads spam_training_log only and never JOINs back to messages, so
-- emptying Junk cannot silently drop training records.

-- v0.2 feature columns on the v0.1 training log (nullable so v0.1 rows stay valid).
ALTER TABLE spam_training_log
  ADD COLUMN IF NOT EXISTS subject           TEXT,
  ADD COLUMN IF NOT EXISTS body_text         TEXT,
  ADD COLUMN IF NOT EXISTS body_html         TEXT,
  ADD COLUMN IF NOT EXISTS token_counts      JSONB,
  ADD COLUMN IF NOT EXISTS flag_features     JSONB,
  ADD COLUMN IF NOT EXISTS sender_domain     VARCHAR(255),
  ADD COLUMN IF NOT EXISTS attachment_types  TEXT[];

CREATE INDEX IF NOT EXISTS idx_spam_training_log_user_created
  ON spam_training_log (user_id, created_at DESC);

-- Per-user Naive Bayes model state. Vocabulary is a JSONB map of
-- {word: {spam, ham}} running counts. total_spam/total_ham are REAL because
-- full retrain aggregates decay-weighted fractional contributions.
CREATE TABLE IF NOT EXISTS spam_models (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  vocabulary           JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_spam           REAL NOT NULL DEFAULT 0,
  total_ham            REAL NOT NULL DEFAULT 0,
  prior_spam           REAL NOT NULL DEFAULT 0.5,
  prior_ham            REAL NOT NULL DEFAULT 0.5,
  training_records     BIGINT NOT NULL DEFAULT 0,
  decay_threshold_days INTEGER NOT NULL DEFAULT 90 CHECK (decay_threshold_days BETWEEN 7 AND 365),
  model_version        INTEGER NOT NULL DEFAULT 1,
  last_trained_at      TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spam_models_last_trained
  ON spam_models (last_trained_at NULLS FIRST);

-- Per-account opt-in for automatic classification (default OFF).
ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS antispam_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_email_accounts_antispam_enabled
  ON email_accounts (id) WHERE antispam_enabled = true;

-- authserv-id whose Authentication-Results headers are trusted for an account.
-- NULL (default) = trust nothing: untrusted headers are ignored and the auth
-- signal stays neutral (safe default; forged headers can otherwise silence
-- AUTH_*_FAIL rules and earn pass weights).
ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS trusted_authserv_id VARCHAR(255);

-- GDPR deletion audit trail: one row per reset, never reuses the training table.
CREATE TABLE IF NOT EXISTS spam_training_deletions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id      UUID REFERENCES email_accounts(id) ON DELETE SET NULL,
  scope           VARCHAR(20) NOT NULL CHECK (scope IN ('per_account', 'all')),
  records_deleted BIGINT NOT NULL,
  reason          VARCHAR(50) DEFAULT 'gdpr_erasure',
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address      INET,
  user_agent      TEXT
);

CREATE INDEX IF NOT EXISTS idx_spam_training_deletions_user
  ON spam_training_deletions (user_id, requested_at DESC);

COMMENT ON TABLE spam_models IS
  'Per-user Naive Bayes spam classifier state. Counts are running totals updated incrementally on user feedback; full retrain rebuilds from spam_training_log with exponential time decay.';
