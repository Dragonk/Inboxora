-- Gmail API body decoding in 4.1.0 learns a bounded fallback for malformed legacy
-- Central-European messages that omit/misdeclare charset. Reader bodies cached by an
-- older build would otherwise remain marked complete forever and never be decoded again.
--
-- Do not delete cached bodies here: marking the reader cache incomplete is enough to
-- make the normal on-demand read refresh it the next time a person opens the message.
UPDATE messages m
   SET gmail_reader_body_complete = false
 WHERE gmail_reader_body_complete = true
   AND (m.body_html IS NOT NULL OR m.body_text IS NOT NULL)
   AND EXISTS (
     SELECT 1
       FROM email_accounts a
      WHERE a.id = m.account_id
        AND a.mail_transport = 'gmail_api'
   );
