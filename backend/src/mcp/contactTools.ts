import { z } from 'zod';
import { query } from '../services/db.js';
import { domainRead, domainRequest } from './bridge.js';
import { allowedId, McpError, requireBook, type Grant } from './policy.js';
import { id, page, queryPath, readTool, records, selectedFields, writeTool } from './registry.js';

const contactFields = ['id','uid','display_name','first_name','last_name','primary_email','emails','phones','organization','notes','birthday','anniversary',
  'contact_dates','contactDates','title','role','nickname','urls','addresses','instant_messages','instantMessages','categories','address_book_id','address_book_name',
  'is_auto','etag','read_only','source','book_source','updated_at'] as const;
export async function permittedBooks(grant: Grant) {
  const response = await domainRead(grant.user_id, '/contacts/address-books');
  return records(response.addressBooks).filter(book => allowedId(grant.restrictions.addressBooks, String(book.id)))
    .map(book => selectedFields(book, ['id','name','source','read_only','source_access','user_access','account_id','contact_count']));
}
async function requireContact(grant: Grant, contactId: string, expectedEtag?: string) {
  const result = await query<{ address_book_id: string; etag: string }>('SELECT address_book_id,etag FROM contacts WHERE id=$1 AND user_id=$2', [contactId, grant.user_id]);
  const contact = result.rows[0];
  if (!contact) throw new McpError('RESOURCE_UNAVAILABLE', 'Contact not found.', 404);
  await requireBook(grant, contact.address_book_id);
  if (expectedEtag !== undefined && contact.etag !== expectedEtag) throw new McpError('REVISION_CHANGED', 'This contact changed. Read it again before editing.', 409);
  return contact;
}
const text = z.string().max(2000).nullable();
const values = z.array(z.object({ value: z.string().max(2000), type: z.string().max(100).optional(), label: z.string().max(100).optional(), pref: z.boolean().optional() }).strict()).max(50);
const contactShape = {
  displayName: text.optional(), firstName: text.optional(), lastName: text.optional(), emails: values.optional(), phones: values.optional(),
  organization: text.optional(), notes: z.string().max(100000).nullable().optional(), birthday: z.string().max(10).nullable().optional(), anniversary: z.string().max(10).nullable().optional(),
  title: text.optional(), role: text.optional(), nickname: text.optional(), urls: values.optional(), instantMessages: values.optional(),
  categories: z.array(z.string().max(200)).max(100).optional(),
  contactDates: z.array(z.object({ date: z.string().max(10), label: z.string().max(100) }).strict()).max(50).optional(),
  addresses: z.array(z.object({ type: z.string().max(100).optional(), label: z.string().max(100).optional(), street: z.string().max(2000).optional(),
    city: z.string().max(500).optional(), region: z.string().max(500).optional(), postalCode: z.string().max(100).optional(), country: z.string().max(500).optional(),
    poBox: z.string().max(500).optional(), extended: z.string().max(2000).optional(), pref: z.boolean().optional() }).strict()).max(30).optional(),
};
export const contactTools = [
  readTool('list_address_books', 'List permitted local and synchronized address books with their actual read-only/write-back capabilities.', 'contacts.read', {}, async grant => ({ addressBooks: await permittedBooks(grant) })),
  readTool('search_contacts', 'Search names, email addresses, phone numbers and organizations in all permitted address books, including hidden books. Blank query lists contacts.', 'contacts.read',
    { query: z.string().max(500).default(''), addressBookIds: z.array(id).min(1).max(100).optional(), ...page }, async (grant, args) => {
      const books = await permittedBooks(grant); const ids = args.addressBookIds ?? books.map(book => String(book.id));
      if (ids.some(value => !books.some(book => book.id === value))) throw new McpError('RESOURCE_FORBIDDEN', 'An address book is outside the integration permissions.');
      if (!ids.length) return { contacts: [], total: 0, nextOffset: null };
      const response = await domainRead(grant.user_id, queryPath('/contacts', { q: args.query, addressBookIds: ids.join(','), limit: args.limit, offset: args.offset }));
      return { contacts: records(response.contacts).map(contact => selectedFields(contact, contactFields)), total: response.total,
        nextOffset: typeof response.total === 'number' && args.offset + args.limit < response.total ? args.offset + args.limit : null };
    }),
  readTool('get_contact', 'Read a permitted contact and its etag. Raw vCards, embedded photos and connection credentials are not returned.', 'contacts.read', { contactId: id }, async (grant, args) => {
    await requireContact(grant, args.contactId);
    const response = await domainRead(grant.user_id, `/contacts/${args.contactId}`);
    const contact = response.contact && typeof response.contact === 'object' && !Array.isArray(response.contact) ? response.contact as Record<string, unknown> : response;
    return { contact: selectedFields(contact, contactFields), contentIsUntrusted: true };
  }),
  writeTool('create_contact', 'Create a contact in a writable address book. Native and DAV sources use their source-first write-back; read-only/imported books are not silently edited locally.', 'contacts.write', { addressBookId: id, ...contactShape },
    async (grant, args) => { await requireBook(grant, args.addressBookId); },
    (grant, args, operationId) => domainRequest(grant.user_id, 'POST', '/contacts', args, operationId)),
  writeTool('update_contact', 'Update only supplied fields of a contact. Read it first and supply its current etag; omitted fields are preserved.', 'contacts.write', { contactId: id, expectedEtag: z.string().min(1).max(200), ...contactShape },
    async (grant, args) => { await requireContact(grant, args.contactId, args.expectedEtag); },
    (grant, args, operationId) => domainRequest(grant.user_id, 'PATCH', `/contacts/${args.contactId}`, args, operationId)),
  writeTool('delete_contact', 'Delete a contact from its writable source. This may permanently remove it from the synchronized address book.', 'contacts.write', { contactId: id, expectedEtag: z.string().min(1).max(200) },
    async (grant, args) => { await requireContact(grant, args.contactId, args.expectedEtag); },
    (grant, args, operationId) => domainRequest(grant.user_id, 'DELETE', `/contacts/${args.contactId}`, undefined, operationId)),
];
