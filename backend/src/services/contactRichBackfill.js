import { parseVCard } from '../utils/vcard.js';

/**
 * Populate the denormalized rich-contact columns from authoritative legacy
 * vCards. It is idempotent and leaves contacts.vcard untouched.
 */
export async function backfillRichContactFields(client) {
  const result = await client.query(`
    SELECT id, vcard
    FROM contacts
    WHERE vcard IS NOT NULL
      AND rich_fields_backfilled_at IS NULL
      AND (
        (vcard ~* '(?m)^(?:[A-Z0-9-]+\\.)?TITLE[^:]*:.+' AND title IS NULL)
        OR (vcard ~* '(?m)^(?:[A-Z0-9-]+\\.)?ROLE[^:]*:.+' AND role IS NULL)
        OR (vcard ~* '(?m)^(?:[A-Z0-9-]+\\.)?NICKNAME[^:]*:.+' AND nickname IS NULL)
        OR (vcard ~* '(?m)^(?:[A-Z0-9-]+\\.)?URL[^:]*:.+' AND urls = '[]'::jsonb)
        OR (vcard ~* '(?m)^(?:[A-Z0-9-]+\\.)?IMPP[^:]*:.+' AND instant_messages = '[]'::jsonb)
        OR (vcard ~* '(?m)^(?:[A-Z0-9-]+\\.)?CATEGORIES[^:]*:.+' AND categories = '[]'::jsonb)
        OR (vcard ~* '(?m)^(?:[A-Z0-9-]+\\.)?ADR[^:]*:.+' AND addresses = '[]'::jsonb)
      )
  `);

  let count = 0;
  for (const contact of result.rows) {
    const rich = parseVCard(contact.vcard);
    await client.query(`
      UPDATE contacts SET
        title = $1, role = $2, nickname = $3, urls = $4,
        instant_messages = $5, categories = $6, addresses = $7,
        rich_fields_backfilled_at = NOW()
      WHERE id = $8
    `, [
      rich.title, rich.role, rich.nickname,
      JSON.stringify(rich.urls), JSON.stringify(rich.instantMessages),
      JSON.stringify(rich.categories), JSON.stringify(rich.addresses), contact.id,
    ]);
    count++;
  }
  return count;
}
