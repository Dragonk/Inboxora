-- A NULL default means the primary mailbox identity. The composite foreign key
-- prevents selecting an alias from another account, including another user's.
-- PostgreSQL 15+ supports SET NULL limited to the optional referencing column.
ALTER TABLE account_aliases
  ADD CONSTRAINT account_aliases_id_account_key UNIQUE (id, account_id);

ALTER TABLE email_accounts ADD COLUMN default_alias_id UUID;
ALTER TABLE email_accounts
  ADD CONSTRAINT email_accounts_default_alias_fk
  FOREIGN KEY (default_alias_id, id) REFERENCES account_aliases (id, account_id)
  ON DELETE SET NULL (default_alias_id);

CREATE INDEX email_accounts_default_alias_idx
  ON email_accounts (default_alias_id) WHERE default_alias_id IS NOT NULL;
