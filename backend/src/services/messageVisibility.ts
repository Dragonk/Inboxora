/**
 * Shared canonical-message read projection. Outer message alias: m.
 * Verified legacy bindings are compatibility addresses, not additional mail.
 * Their rows remain intact for old links and recovery. RFC Message-ID alone is
 * never sufficient; uncertain bindings, stale connections, deleted canonicals
 * and unconfirmed folder changes retain the original physical row.
 */
export const visiblePhysicalMessageSql = `NOT EXISTS (
  SELECT 1 FROM graph_legacy_message_bindings vb
  JOIN messages vn ON vn.id = vb.canonical_message_id
  JOIN email_accounts va ON va.id = vb.account_id
  WHERE vb.legacy_message_id = m.id AND vb.account_id = m.account_id
    AND vb.status = 'bound' AND va.mail_transport = 'microsoft_graph'
    AND vb.connection_id = va.provider_connection_id
    AND vn.account_id = m.account_id AND vn.is_deleted = false
    AND NULLIF(BTRIM(m.provider_message_id), '') IS NULL
    AND NULLIF(BTRIM(vn.provider_message_id), '') IS NOT NULL
    AND (vn.folder = m.folder
      OR vb.evidence->>'kind' = 'confirmed_provider_move'
      OR vb.evidence->>'physical_move_confirmed' = 'true')
)`;
