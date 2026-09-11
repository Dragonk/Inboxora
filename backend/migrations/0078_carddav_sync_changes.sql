-- Durable CardDAV deltas, including deletions and moves made through the REST UI.
ALTER TABLE address_books ADD COLUMN IF NOT EXISTS sync_version BIGINT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS contact_sync_changes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  address_book_id UUID NOT NULL REFERENCES address_books(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  version BIGINT NOT NULL,
  etag TEXT,
  vcard TEXT,
  deleted BOOLEAN NOT NULL,
  UNIQUE(address_book_id, version)
);
CREATE OR REPLACE FUNCTION record_contact_sync_change() RETURNS TRIGGER AS $$
DECLARE
  next_version BIGINT;
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (OLD.address_book_id IS DISTINCT FROM NEW.address_book_id OR COALESCE(OLD.dav_filename, OLD.uid || '.vcf') IS DISTINCT FROM COALESCE(NEW.dav_filename, NEW.uid || '.vcf'))) THEN
    UPDATE address_books SET sync_version = sync_version + 1, sync_token = gen_random_uuid()::text, updated_at = NOW()
      WHERE id = OLD.address_book_id RETURNING sync_version INTO next_version;
    IF FOUND THEN
      INSERT INTO contact_sync_changes(address_book_id, filename, version, deleted)
        VALUES(OLD.address_book_id, COALESCE(OLD.dav_filename, OLD.uid || '.vcf'), next_version, true);
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    UPDATE address_books SET sync_version = sync_version + 1, sync_token = gen_random_uuid()::text, updated_at = NOW()
      WHERE id = NEW.address_book_id RETURNING sync_version INTO next_version;
    IF FOUND THEN
      INSERT INTO contact_sync_changes(address_book_id, filename, version, etag, vcard, deleted)
        VALUES(NEW.address_book_id, COALESCE(NEW.dav_filename, NEW.uid || '.vcf'), next_version, NEW.etag, NEW.vcard, false);
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS contacts_sync_change ON contacts;
CREATE TRIGGER contacts_sync_change AFTER INSERT OR UPDATE OR DELETE ON contacts
  FOR EACH ROW EXECUTE FUNCTION record_contact_sync_change();
