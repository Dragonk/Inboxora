-- Address books are independent user-managed CardDAV collections. Visibility only
-- affects Inboxora's contact list; DAV clients still choose collections themselves.
ALTER TABLE address_books ADD COLUMN IF NOT EXISTS visible BOOLEAN NOT NULL DEFAULT true;

-- A person may legitimately exist in several independent books (for example,
-- separate personal and work cards with the same email address). The former
-- user-wide uniqueness rule prevented that and also disagreed with the
-- address-book scoped upsert used for sent-mail contacts.
DROP INDEX IF EXISTS contacts_user_primary_email_idx;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_address_book_primary_email_idx
  ON contacts (address_book_id, primary_email)
  WHERE primary_email IS NOT NULL;
