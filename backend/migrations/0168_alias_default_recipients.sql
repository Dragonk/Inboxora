-- Follow-up to 0151: aliases inherit account defaults when NULL and override them when an array is stored.
-- Empty arrays are intentional overrides that disable that recipient type for the alias.
ALTER TABLE account_aliases
  ADD COLUMN default_cc TEXT[] DEFAULT NULL,
  ADD COLUMN default_bcc TEXT[] DEFAULT NULL,
  ADD CONSTRAINT account_aliases_default_cc_bounded
    CHECK (default_cc IS NULL OR account_default_recipients_bounded(default_cc)),
  ADD CONSTRAINT account_aliases_default_bcc_bounded
    CHECK (default_bcc IS NULL OR account_default_recipients_bounded(default_bcc));
