-- A rule worker can store plain-text extraction without the full reader body.
-- Only a successful reader/prefetch body read can set this completeness marker.
ALTER TABLE messages ADD COLUMN graph_reader_body_complete BOOLEAN NOT NULL DEFAULT false;
