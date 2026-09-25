-- Contacts projected from providers are identified by their provider object links,
-- not an e-mail address. Keep e-mail idempotency only for deliberately local
-- materialisations such as recipient learning.
CREATE TABLE IF NOT EXISTS contact_local_email_keys (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address_book_id UUID NOT NULL REFERENCES address_books(id) ON DELETE CASCADE,
  normalized_email TEXT NOT NULL,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, address_book_id, normalized_email),
  UNIQUE (contact_id)
);

-- Rows in an Inboxora-owned address book are the only safe historical candidates:
-- never infer a local learning key for Google, Microsoft or DAV projections.
INSERT INTO contact_local_email_keys (user_id, address_book_id, normalized_email, contact_id)
SELECT c.user_id, c.address_book_id, lower(c.primary_email), c.id
FROM contacts c
JOIN address_books ab ON ab.id = c.address_book_id AND ab.user_id = c.user_id
WHERE ab.source = 'local'
  AND c.primary_email IS NOT NULL
  AND btrim(c.primary_email) <> ''
ON CONFLICT (user_id, address_book_id, normalized_email) DO NOTHING;

-- All external contacts may legitimately share an address, including two remote
-- identities in one address book. The local learning-key table above replaces
-- the old conflict target used by sender learning.
DROP INDEX IF EXISTS contacts_book_primary_email_idx;
CREATE INDEX IF NOT EXISTS contacts_book_primary_email_lookup_idx
  ON contacts (address_book_id, primary_email)
  WHERE primary_email IS NOT NULL;
