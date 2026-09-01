-- Contact dates are standard vCard / Android-compatible date fields. They are optional
-- and deliberately keep the year so anniversaries can preserve their original year.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS birthday DATE,
  ADD COLUMN IF NOT EXISTS anniversary DATE;

CREATE INDEX IF NOT EXISTS contacts_user_birthday_idx
  ON contacts (user_id, birthday)
  WHERE birthday IS NOT NULL;

CREATE INDEX IF NOT EXISTS contacts_user_anniversary_idx
  ON contacts (user_id, anniversary)
  WHERE anniversary IS NOT NULL;
