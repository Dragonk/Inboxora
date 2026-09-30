-- Native providers do not have an IMAP host. An old reconnect callback could
-- record this local validation error after the atomic mail-transport switch.
-- Clear only that exact artifact; do not change grants, provider diagnostics,
-- migration failures, message data, endpoints or genuine IMAP-account errors.
UPDATE email_accounts SET sync_error = NULL
WHERE mail_transport IN ('gmail_api', 'microsoft_graph')
  AND sync_error = 'Host must be a string';
