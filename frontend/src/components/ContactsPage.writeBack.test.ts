import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name: string) => readFile(new URL(`./${name}`, import.meta.url), 'utf8');

test('address-book presentation carries collection ownership and write-back state', async () => {
  const source = await read('ContactsPage.tsx');
  assert.match(source, /collection_id\?: string \| null/);
  assert.match(source, /read_only\?: boolean/);
  assert.match(source, /writableContactTarget/);
});

test('provider contact synchronization targets the owning account', async () => {
  const source = await read('ContactsPage.tsx');
  assert.match(source, /providerSyncAccount/);
  assert.match(source, /syncAccountProviderFeature\(accountId, 'contacts'\)/);
  assert.doesNotMatch(source, /api\.(googleContacts|microsoftContacts)\.sync\(/);
});

test('new contacts retain an explicitly selected writable book', async () => {
  const source = await read('ContactsPage.tsx');
  assert.match(source, /newAddressBookId/);
  assert.match(source, /data-testid="contacts-new-target"/);
  assert.match(source, /addressBookId: newAddressBookId/);
});
