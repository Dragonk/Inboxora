-- Apply after 0159 and all lower-numbered migrations, before worker startup.
-- Older IMAP bulk actions could lose an in-memory retry without a provider
-- journal row. Their retained local-change markers identify readback candidates.
-- These are observation-only obligations: never replay historical write values.
INSERT INTO mail_flag_readbacks (message_id, next_attempt_at)
SELECT m.id, NOW() + INTERVAL '31 seconds'
FROM messages m
JOIN email_accounts a ON a.id = m.account_id
WHERE a.enabled = true AND m.is_deleted = false
  AND (m.read_changed_at IS NOT NULL OR m.star_changed_at IS NOT NULL)
  AND (
    COALESCE(a.mail_transport, 'imap_smtp') = 'imap_smtp'
    OR NULLIF(BTRIM(m.provider_message_id), '') IS NOT NULL
  )
ON CONFLICT (message_id) DO NOTHING;
