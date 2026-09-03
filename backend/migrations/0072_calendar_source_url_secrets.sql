-- Calendar source URLs may contain bearer tokens and must not be stored in plaintext.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE calendar_import_sources
  ADD COLUMN IF NOT EXISTS url_fingerprint TEXT;

CREATE OR REPLACE FUNCTION calendar_source_url_fingerprint()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Legacy writers may omit the new column during a rolling upgrade. Once the
  -- application writes ciphertext, it supplies the plaintext URL fingerprint.
  IF NEW.url IS NOT NULL AND (NEW.url_fingerprint IS NULL OR NEW.url NOT LIKE 'enc:v1:%') THEN
    NEW.url_fingerprint := encode(digest(NEW.url, 'sha256'), 'hex');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS calendar_source_url_fingerprint_trigger ON calendar_import_sources;
CREATE TRIGGER calendar_source_url_fingerprint_trigger
  BEFORE INSERT OR UPDATE OF url, url_fingerprint ON calendar_import_sources
  FOR EACH ROW EXECUTE FUNCTION calendar_source_url_fingerprint();

UPDATE calendar_import_sources
SET url_fingerprint = encode(digest(url, 'sha256'), 'hex')
WHERE url IS NOT NULL AND url_fingerprint IS NULL;

ALTER TABLE calendar_import_sources
  DROP CONSTRAINT IF EXISTS calendar_import_sources_user_id_url_key;

CREATE UNIQUE INDEX IF NOT EXISTS calendar_import_sources_user_url_fingerprint_key
  ON calendar_import_sources (user_id, url_fingerprint);

ALTER TABLE calendar_import_sources
  ALTER COLUMN url_fingerprint SET NOT NULL;