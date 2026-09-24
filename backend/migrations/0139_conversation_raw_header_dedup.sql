-- Conversation Engine v2 already stores the parsed threading evidence and a fixed-size
-- header fingerprint on logical_messages. Keeping the complete RFC header block there
-- duplicated messages.conversation_raw_headers and pushed large installations into TOAST.
-- Stop carrying the duplicate payload forward; the physical message remains the source
-- used for rebuilds and diagnostics.
UPDATE logical_messages
   SET raw_headers = NULL
 WHERE raw_headers IS NOT NULL;

COMMENT ON COLUMN logical_messages.raw_headers IS
  'Legacy compatibility column. Conversation Engine no longer populates it; full headers remain on messages.conversation_raw_headers.';
