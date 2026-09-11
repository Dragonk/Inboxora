-- Multiple labelled contact dates, denormalized from the authoritative vCard.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS contact_dates JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Preserve dates imported by the original flat columns when upgrading.
UPDATE contacts
SET contact_dates = (
  SELECT COALESCE(jsonb_agg(jsonb_build_object('label', label, 'value', value) ORDER BY ordinal), '[]'::jsonb)
  FROM (
    SELECT 1 AS ordinal, 'Birthday' AS label, birthday::text AS value WHERE birthday IS NOT NULL
    UNION ALL
    SELECT 2, 'Anniversary', anniversary::text WHERE anniversary IS NOT NULL
  ) legacy
)
WHERE contact_dates = '[]'::jsonb AND (birthday IS NOT NULL OR anniversary IS NOT NULL);

CREATE INDEX IF NOT EXISTS contacts_contact_dates_gin_idx
  ON contacts USING GIN (contact_dates);
