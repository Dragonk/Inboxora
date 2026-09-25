-- UX-01/UX-02: user presentation is independent from source sync and write permissions.
-- Apply after 0128_account_provider_feature_settings.sql before serving grouped calendar sources.
CREATE TABLE IF NOT EXISTS user_calendar_source_preferences (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  collapsed BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, source_id)
);

CREATE TABLE IF NOT EXISTS user_calendar_presentation_preferences (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL,
  sidebar_hidden BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, calendar_id)
);
