/** Stable account and DAV-source identities; no credentials cross the API. */
export const ADDRESS_BOOK_PRESENTATION_SQL = `
  SELECT ab.id, ab.name, ab.source, ab.visible, ab.dav_mode, COUNT(c.id)::int AS contact_count,
         ic.id AS collection_id, ic.connection_id, ic.source_connection_id,
         ic.source_access, ic.user_access, pc.provider,
         ea.id AS account_id, ea.email_address AS account_email, ea.name AS account_name,
         sc.integration_id AS dav_source_id, ui.label AS source_label,
         ui.config->>'serverUrl' AS source_url, ui.config->>'username' AS source_username
    FROM address_books ab
    LEFT JOIN contacts c ON c.address_book_id = ab.id AND c.user_id = ab.user_id
    LEFT JOIN integration_collections ic
           ON ic.local_address_book_id = ab.id AND ic.kind = 'address_book' AND ic.user_id = ab.user_id
    LEFT JOIN provider_connections pc ON pc.id = ic.connection_id AND pc.user_id = ab.user_id
    LEFT JOIN source_connections sc ON sc.id = ic.source_connection_id AND sc.user_id = ab.user_id
    LEFT JOIN user_integrations ui ON ui.id = sc.integration_id AND ui.user_id = ab.user_id AND ui.provider = 'carddav'
    LEFT JOIN LATERAL (
      SELECT
        CASE WHEN COUNT(*) = 1 OR (ic.account_id IS NOT NULL AND COUNT(*) > 0)
             THEN (array_agg(candidate.id ORDER BY CASE WHEN candidate.id = ic.account_id THEN 0 WHEN candidate.provider_connection_id = pc.id THEN 1 ELSE 2 END, candidate.created_at ASC, candidate.id ASC))[1]
             ELSE NULL END AS id,
        CASE WHEN COUNT(*) = 1 OR (ic.account_id IS NOT NULL AND COUNT(*) > 0)
             THEN (array_agg(candidate.email_address ORDER BY CASE WHEN candidate.id = ic.account_id THEN 0 WHEN candidate.provider_connection_id = pc.id THEN 1 ELSE 2 END, candidate.created_at ASC, candidate.id ASC))[1]
             ELSE NULL END AS email_address,
        CASE WHEN COUNT(*) = 1 OR (ic.account_id IS NOT NULL AND COUNT(*) > 0)
             THEN (array_agg(candidate.name ORDER BY CASE WHEN candidate.id = ic.account_id THEN 0 WHEN candidate.provider_connection_id = pc.id THEN 1 ELSE 2 END, candidate.created_at ASC, candidate.id ASC))[1]
             ELSE NULL END AS name
        FROM email_accounts candidate
       WHERE candidate.user_id = ab.user_id
         AND pc.id IS NOT NULL
         AND (
           (
             ic.account_id IS NOT NULL
             AND candidate.id = ic.account_id
             AND (
               candidate.provider_connection_id = pc.id
               OR (pc.provider_user_id IS NOT NULL AND lower(candidate.email_address) = lower(pc.provider_user_id))
             )
           )
           OR (
             ic.account_id IS NULL
             AND (
               candidate.provider_connection_id = pc.id
               OR (pc.provider_user_id IS NOT NULL AND lower(candidate.email_address) = lower(pc.provider_user_id))
             )
           )
         )
    ) ea ON true
   WHERE ab.user_id = $1
     AND (
       pc.id IS NULL
       OR pc.provider NOT IN ('google', 'microsoft')
       OR ea.id IS NOT NULL
       OR EXISTS (
         SELECT 1 FROM email_accounts candidate
          WHERE candidate.user_id = ab.user_id
            AND (
              candidate.provider_connection_id = pc.id
              OR (pc.provider_user_id IS NOT NULL AND lower(candidate.email_address) = lower(pc.provider_user_id))
            )
       )
     )
   GROUP BY ab.id, ic.id, pc.provider, ea.id, ea.email_address, ea.name, sc.integration_id, ui.id
   ORDER BY ab.created_at ASC, ab.id ASC`;
