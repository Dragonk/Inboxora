import type { PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { generateVCard } from '../utils/vcard.js';

/**
 * Idempotently materialise an Inboxora-owned contact for a mail address.
 *
 * Provider projections never take this path: their identity is the remote object
 * link. The separate key table keeps recipient learning stable after contacts no
 * longer enforce uniqueness by e-mail.
 */
export async function learnLocalRecipient(client: PoolClient, input: {
  userId: string;
  addressBookId: string;
  email: string;
  displayName: string;
  source: 'sent' | 'inbound';
  sentAt?: Date;
}): Promise<{ contactId: string; created: boolean }> {
  const normalizedEmail = input.email.trim().toLowerCase();
  if (!normalizedEmail) throw new Error('A recipient e-mail is required');

  // The missing-key case must be serialised too. Without this lock two sends can
  // both create a contact before either owns the e-mail key.
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`${input.userId}:${input.addressBookId}:${normalizedEmail}`],
  );

  const key = await client.query<{ contact_id: string }>(
    `SELECT contact_id FROM contact_local_email_keys
      WHERE user_id = $1 AND address_book_id = $2 AND normalized_email = $3`,
    [input.userId, input.addressBookId, normalizedEmail],
  );
  let contactId = key.rows[0]?.contact_id;
  let created = false;

  if (!contactId) {
    const uid = randomUUID();
    const emails = [{ value: normalizedEmail, type: 'other', primary: true }];
    const vcard = generateVCard({ uid, displayName: input.displayName, emails });
    const etag = createHash('md5').update(vcard).digest('hex');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO contacts (
         address_book_id, user_id, uid, vcard, etag, display_name, primary_email,
         emails, is_auto, send_count, last_sent
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
       RETURNING id`,
      [
        input.addressBookId, input.userId, uid, vcard, etag, input.displayName,
        normalizedEmail, JSON.stringify(emails), input.source === 'inbound',
        input.source === 'sent' ? 1 : 0, input.source === 'sent' ? input.sentAt ?? new Date() : null,
      ],
    );
    contactId = inserted.rows[0]?.id;
    if (!contactId) throw new Error('Could not create learned recipient');
    await client.query(
      `INSERT INTO contact_local_email_keys (user_id, address_book_id, normalized_email, contact_id)
       VALUES ($1, $2, $3, $4)`,
      [input.userId, input.addressBookId, normalizedEmail, contactId],
    );
    created = true;
  }

  if (input.source === 'sent') {
    const sentAt = input.sentAt ?? new Date();
    const updated = await client.query(
      `UPDATE contacts SET
         send_count = send_count + CASE WHEN $1 THEN 0 ELSE 1 END,
         last_sent = $2,
         is_auto = false,
         display_name = CASE WHEN is_auto THEN $3 ELSE display_name END,
         updated_at = NOW()
       WHERE id = $4 AND user_id = $5 AND address_book_id = $6`,
      [created, sentAt, input.displayName, contactId, input.userId, input.addressBookId],
    );
    if (!updated.rowCount) throw new Error('Learned recipient contact no longer exists');
  }

  return { contactId, created };
}
