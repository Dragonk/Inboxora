-- FV-05: distinguish a provider's partial metadata headers from a complete header read.
-- Apply after 0121_provider_rule_deferred_queue.sql and before deploying rule hydration.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS parsed_headers_complete BOOLEAN NOT NULL DEFAULT false;
