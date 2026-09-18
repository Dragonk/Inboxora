-- Distinct-message maturity counters for the antispam model. training_records
-- stays the raw row count; usable_spam/usable_ham count distinct usable
-- samples per class and gate ML activation (see isModelMature). Nullable-safe
-- defaults keep pre-existing rows valid; the next retrain fills real values.
-- Apply before deploying code that reads/writes usable_spam/usable_ham.
ALTER TABLE spam_models
  ADD COLUMN IF NOT EXISTS usable_spam BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usable_ham BIGINT NOT NULL DEFAULT 0;
