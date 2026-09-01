-- Preserve the complete original ICS document for pull-only URL imports.
-- Event rows remain a bounded render/search projection; this table is the
-- interoperability source of truth for sibling components and calendar-level properties.
CREATE TABLE IF NOT EXISTS calendar_import_documents (
  source_id UUID PRIMARY KEY REFERENCES calendar_import_sources(id) ON DELETE CASCADE,
  raw_ical TEXT NOT NULL CHECK (octet_length(raw_ical) <= 10485760),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
