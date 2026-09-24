/**
 * Address-book actions need one unambiguous owning account. Calendar/contact
 * collections are usually connection-scoped, unlike mail collections; multiple
 * mailbox rows on that connection must not duplicate books or choose an arbitrary
 * sync target. Legacy ambiguous links remain visible but have no account action.
 */
export const ADDRESS_BOOK_PRESENTATION_SQL = `
  SELECT ab.id, ab.name, ab.source, ab.visible, ab.dav_mode, COUNT(c.id)::int AS contact_count,
         ic.id AS collection_id, ic.connection_id, ic.source_connection_id,
         ic.source_access, ic.user_access, pc.provider,
         ea.id AS account_id, ea.email_address AS account_email
    FROM address_books ab
    LEFT JOIN contacts c ON c.address_book_id = ab.id AND c.user_id = ab.user_id
    LEFT JOIN integration_collections ic
           ON ic.local_address_book_id = ab.id AND ic.kind = 'address_book' AND ic.user_id = ab.user_id
    LEFT JOIN provider_connections pc ON pc.id = ic.connection_id AND pc.user_id = ab.user_id
    LEFT JOIN LATERAL (
      SELECT CASE WHEN COUNT(*) = 1 THEN (array_agg(candidate.id))[1] ELSE NULL END AS id,
             CASE WHEN COUNT(*) = 1 THEN (array_agg(candidate.email_address))[1] ELSE NULL END AS email_address
        FROM email_accounts candidate
       WHERE candidate.user_id = ab.user_id AND pc.id IS NOT NULL
         AND candidate.provider_connection_id = pc.id
         AND (ic.account_id IS NULL OR candidate.id = ic.account_id)
    ) ea ON true
   WHERE ab.user_id = $1
   GROUP BY ab.id, ic.id, pc.provider, ea.id, ea.email_address
   ORDER BY ab.created_at ASC`;
