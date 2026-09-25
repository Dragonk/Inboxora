-- Apply after 0134: local recipient-learning idempotency is enforced by
-- contact_local_email_keys, while provider contacts use their object identities.
-- 0075 introduced this second legacy name, which 0134 did not remove. Distinct
-- provider contacts in the same address book must be allowed to share an email.
DROP INDEX IF EXISTS contacts_address_book_primary_email_idx;

-- Retain the nonunique lookup from 0134 without changing contacts or local keys.
CREATE INDEX IF NOT EXISTS contacts_book_primary_email_lookup_idx
  ON contacts (address_book_id, primary_email)
  WHERE primary_email IS NOT NULL;
