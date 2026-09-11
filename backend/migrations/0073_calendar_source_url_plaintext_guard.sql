-- Reject plaintext calendar source URLs from legacy and current writers.
CREATE OR REPLACE FUNCTION calendar_source_url_fingerprint()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.url IS NOT NULL AND NEW.url NOT LIKE 'enc:v1:%' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Calendar source URLs must be encrypted before storage';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS calendar_source_url_fingerprint_trigger ON calendar_import_sources;
CREATE TRIGGER calendar_source_url_fingerprint_trigger
  BEFORE INSERT OR UPDATE OF url, url_fingerprint ON calendar_import_sources
  FOR EACH ROW EXECUTE FUNCTION calendar_source_url_fingerprint();
