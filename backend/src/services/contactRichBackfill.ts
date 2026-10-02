import { parseVCard } from '../utils/vcard.js';
import type { DbClient } from './db.js';

/**
 * Populate the denormalized rich-contact columns from authoritative legacy
 * vCards. It is idempotent and leaves contacts.vcard untouched.
 */
export async function backfillRichContactFields(client: DbClient) {
  const result = await client.query<{ id: string; vcard: string }>(`
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

  if (result.rows.length === 0) return 0;

  const ids = [];
  const titles = [];
  const roles = [];
  const nicknames = [];
  const urls = [];
  const instantMessages = [];
  const categories = [];
  const addresses = [];

  for (const contact of result.rows) {
    const rich = parseVCard(contact.vcard);
    ids.push(contact.id);
    titles.push(rich.title);
    roles.push(rich.role);
    nicknames.push(rich.nickname);
    urls.push(JSON.stringify(rich.urls));
    instantMessages.push(JSON.stringify(rich.instantMessages));
    categories.push(JSON.stringify(rich.categories));
    addresses.push(JSON.stringify(rich.addresses));
  }

  await client.query(`
    UPDATE contacts SET
      title = u.title,
      role = u.role,
      nickname = u.nickname,
      urls = u.urls::jsonb,
      instant_messages = u.instant_messages::jsonb,
      categories = u.categories::jsonb,
      addresses = u.addresses::jsonb,
      rich_fields_backfilled_at = NOW()
    FROM (
      SELECT
        UNNEST($1::text[]) AS id,
        UNNEST($2::text[]) AS title,
        UNNEST($3::text[]) AS role,
        UNNEST($4::text[]) AS nickname,
        UNNEST($5::text[]) AS urls,
        UNNEST($6::text[]) AS instant_messages,
        UNNEST($7::text[]) AS categories,
        UNNEST($8::text[]) AS addresses
    ) AS u
    WHERE contacts.id = u.id
  `, [
    ids, titles, roles, nicknames, urls, instantMessages, categories, addresses
  ]);

  return result.rows.length;
}
