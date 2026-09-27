-- New columns only: PostgreSQL stores the stable NOW() default as metadata for
-- old rows. The first retention period starts at upgrade, not the mail's date.
-- Do NOT infer last opening from is_read or date/synced_at.
ALTER TABLE messages ADD COLUMN body_cache_refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE messages ADD COLUMN body_last_opened_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN body_cache_evicted_at TIMESTAMPTZ;

CREATE FUNCTION track_message_body_cache() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.body_html IS NOT NULL OR NEW.body_text IS NOT NULL THEN
    IF TG_OP = 'INSERT' OR (NEW.body_html, NEW.body_text) IS DISTINCT FROM (OLD.body_html, OLD.body_text) THEN
      NEW.body_cache_refreshed_at := clock_timestamp();
      NEW.body_cache_evicted_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER messages_track_body_cache
BEFORE INSERT OR UPDATE OF body_html, body_text ON messages
FOR EACH ROW EXECUTE FUNCTION track_message_body_cache();
CREATE INDEX messages_body_cache_expiry_idx
  ON messages (GREATEST(body_cache_refreshed_at, body_last_opened_at), id)
  WHERE body_html IS NOT NULL OR body_text IS NOT NULL;

-- Repair already-deployed stale completion state; keep genuine failure backoff.
UPDATE storage_maintenance SET completed_at = NULL, next_run_at = NOW(), updated_at = NOW()
WHERE task = 'vacuum:messages' AND progress->>'needed' = 'true' AND completed_at IS NOT NULL;
