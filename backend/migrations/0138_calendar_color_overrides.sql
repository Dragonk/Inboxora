-- Per-user calendar presentation color, independent from provider write permissions.
-- Apply after 0137_calendar_collection_projection_receipts.sql before enabling the color palette.
ALTER TABLE user_calendar_presentation_preferences
  ADD COLUMN IF NOT EXISTS color_override TEXT;

ALTER TABLE user_calendar_presentation_preferences
  ADD CONSTRAINT user_calendar_presentation_color_format
  CHECK (color_override IS NULL OR color_override ~ '^#[0-9A-Fa-f]{6}$');
