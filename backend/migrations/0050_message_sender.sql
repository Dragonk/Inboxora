-- The RFC 5322 Sender header (IMAP ENVELOPE sender, entry[3]): the mailbox that actually
-- submitted the message. Stored only when it differs from From -- i.e. genuine "on behalf of" /
-- "via" mail (mailing lists, send-as platforms, some spoofing). Null for ordinary mail where
-- Sender is absent or equal to From (servers default ENVELOPE sender to From when the header is
-- absent). Surfaced as "via X" in the message pane so a reader can see who actually sent an
-- on-behalf-of message. See issue #366.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_email VARCHAR(500);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_name VARCHAR(500);
