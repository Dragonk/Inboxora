import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { parseVCard } from '../../utils/vcard.js';
import type { ParsedVCard } from '../../utils/vcard.js';
import { fetchAddressBookCards } from '../carddavClient.js';
import { DavProjectionGuardError, executeDavWriteBack, joinDavUrl } from './davWriteBack.js';
import type {
  DavProjectionCommit,
  DavRemoteResource,
  DavSource,
  DavWriteBackDeps,
  DavWriteBackRouteResult,
  DavWriteBackSpec,
} from './davWriteBack.js';

/**
 * CardDAV write-back (P10): a DAV `PUT`/`DELETE` on an imported address book reaches the server
 * the book was imported from.
 *
 * The remote card is located through `remote_object_links` when the provider projection wrote one,
 * and otherwise by an `addressbook-query` REPORT matched on the vCard UID. Only a confirmed source
 * answer is projected locally, in the same transaction as the link's new version.
 */

export interface CarddavWriteBackInput {
  method: 'PUT' | 'DELETE';
  userId: string;
  book: { id: string; external_url?: string | null; source?: string | null };
  filename: string;
  uid: string;
  /** The parsed projection fields, for a PUT. Null for a DELETE. */
  card: ParsedVCard | null;
  /** The complete vCard resource, for a PUT. Empty for a DELETE. */
  vcard: string;
  exists: boolean;
  localObjectId: string | null;
  localRevision: string | null;
  credentialId?: string | null;
}

function primaryEmailOf(card: ParsedVCard): string | null {
  return (card.emails.find(email => email.primary) || card.emails[0])?.value?.toLowerCase() || null;
}

/** Read the remote address book and find the card whose UID (or href basename) is `uid`. */
export async function resolveRemoteCarddavCard(source: DavSource, uid: string, filename: string): Promise<DavRemoteResource | null> {
  const cards = await fetchAddressBookCards({
    url: source.collectionUrl,
    username: source.username,
    password: source.password,
    allowPrivate: source.allowPrivate,
  });
  const match = cards.find(card => parseVCard(card.vcard).uid === uid)
    ?? cards.find(card => card.href.endsWith(`/${encodeURIComponent(filename)}`));
  return match ? { href: match.href, version: match.etag } : null;
}

function specFor(input: CarddavWriteBackInput): DavWriteBackSpec {
  return {
    method: input.method,
    kind: 'carddav',
    objectType: 'contact',
    userId: input.userId,
    localCollectionId: input.book.id,
    externalUrl: input.book.external_url ?? null,
    localObjectId: input.localObjectId,
    uid: input.uid,
    filename: input.filename,
    exists: input.exists,
    localRevision: input.localRevision,
    body: input.vcard,
    contentType: 'text/vcard; charset=utf-8',
    credentialId: input.credentialId ?? null,
  };
}

/**
 * Apply the confirmed CardDAV answer to `contacts`, guarded by the local entity-tag so a newer
 * local edit is never overwritten by a write that raced it.
 */
export async function commitCarddavProjection(
  client: PoolClient,
  input: CarddavWriteBackInput,
  _commit: DavProjectionCommit,
): Promise<string> {
  const etag = crypto.createHash('md5').update(input.vcard).digest('hex');
  if (input.method === 'DELETE') {
    const deleted = await client.query(
      `DELETE FROM contacts
        WHERE address_book_id = $1 AND COALESCE(dav_filename, uid || '.vcf') = $2 AND etag = $3
        RETURNING id`,
      [input.book.id, input.filename, input.localRevision],
    );
    if (!deleted.rows.length) throw new DavProjectionGuardError();
    return etag;
  }

  const card = input.card;
  if (!card) throw new Error('A CardDAV PUT cannot be projected without a parsed vCard');
  const primaryEmail = primaryEmailOf(card);
  if (input.exists && input.localObjectId) {
    const updated = await client.query(
      `UPDATE contacts SET
         vcard = $1, etag = $2,
         display_name = $3, first_name = $4, last_name = $5,
         primary_email = $6, emails = $7, phones = $8,
         organization = $9, notes = $10, birthday = $11, anniversary = $12, contact_dates = $13::jsonb, photo_data = $14,
         title = $16, role = $17, nickname = $18, urls = $19::jsonb, instant_messages = $20::jsonb,
         categories = $21::jsonb, addresses = $22::jsonb, dav_filename = $23,
         is_auto = false, updated_at = NOW()
       WHERE id = $15 AND etag = $24
       RETURNING id`,
      [
        input.vcard, etag,
        card.displayName, card.firstName, card.lastName,
        primaryEmail,
        JSON.stringify(card.emails), JSON.stringify(card.phones),
        card.organization, card.notes, card.birthday, card.anniversary, JSON.stringify(card.contactDates), card.photoData,
        input.localObjectId, card.title, card.role, card.nickname, JSON.stringify(card.urls), JSON.stringify(card.instantMessages),
        JSON.stringify(card.categories), JSON.stringify(card.addresses), input.filename, input.localRevision,
      ],
    );
    if (!updated.rows.length) throw new DavProjectionGuardError();
    return etag;
  }

  await client.query(`
    INSERT INTO contacts (
      address_book_id, user_id, uid, vcard, etag,
      display_name, first_name, last_name, primary_email,
      emails, phones, organization, notes, birthday, anniversary, contact_dates, photo_data, title, role, nickname, urls, instant_messages, categories, addresses, dav_filename, is_auto
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21::jsonb,$22::jsonb,$23::jsonb,$24::jsonb,$25, false)
  `, [
    input.book.id, input.userId, input.uid, input.vcard, etag,
    card.displayName, card.firstName, card.lastName,
    primaryEmail,
    JSON.stringify(card.emails), JSON.stringify(card.phones),
    card.organization, card.notes, card.birthday, card.anniversary, JSON.stringify(card.contactDates), card.photoData,
    card.title, card.role, card.nickname, JSON.stringify(card.urls), JSON.stringify(card.instantMessages), JSON.stringify(card.categories), JSON.stringify(card.addresses), input.filename,
  ]);
  return etag;
}

function carddavDeps(input: CarddavWriteBackInput): DavWriteBackDeps {
  return {
    resolveRemote: (source, current) => resolveRemoteCarddavCard(source, current.uid, current.filename),
    remoteHrefForCreate: (source, current) => joinDavUrl(source.collectionUrl, current.filename),
    commit: (client, _spec, projection) => commitCarddavProjection(client, input, projection),
  };
}

/** Forward a CardDAV PUT (create or update) to the imported address book's source. */
export async function putCarddavContact(input: CarddavWriteBackInput): Promise<DavWriteBackRouteResult> {
  return executeDavWriteBack(specFor(input), carddavDeps(input));
}

/** Forward a CardDAV DELETE to the imported address book's source. */
export async function deleteCarddavContact(input: CarddavWriteBackInput): Promise<DavWriteBackRouteResult> {
  return executeDavWriteBack(specFor(input), carddavDeps(input));
}
