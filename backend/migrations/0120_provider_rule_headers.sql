-- RV-08: native provider syncs retain the headers that inbox-rule conditions read.
-- The value is a lower-cased header-name to value map; absent remains unknown rather
-- than an empty header bag, so negative conditions cannot match by omission.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS parsed_headers JSONB;
