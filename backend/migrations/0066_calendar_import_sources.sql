-- Pull-only external calendar sources. Secrets are encrypted by the application before storage.
CREATE TABLE IF NOT EXISTS calendar_import_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('caldav', 'ical_url')),
  url TEXT NOT NULL,
  username TEXT,
  password TEXT,
  display_name TEXT NOT NULL,
  color TEXT,
  interval_min INTEGER NOT NULL DEFAULT 60 CHECK (interval_min BETWEEN 15 AND 1440),
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_sync_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, url)
);
