import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name: string) => readFile(new URL(`./${name}`, import.meta.url), 'utf8');

test('Contacts opens the canonical manager from one accessible trigger', async () => {
  const source = await read('ContactsPage.tsx');
  assert.match(source, /data-testid="contacts-manage-books"/);
  assert.match(source, /aria-label=\{t\('contacts\.booksManager\.manage'\)\}/);
  assert.match(source, /<ContactsBooksManager/);
  assert.doesNotMatch(source, /contacts-book-menu/);
});

test('manager separates accounts, resources and import views', async () => {
  const source = await read('ContactsBooksManager.tsx');
  assert.match(source, /view\?: 'accounts' \| 'resources' \| 'import'/);
  assert.match(source, /ServiceSettingsView/);
  assert.match(source, /data-testid="contacts-books-manager"/);
  assert.match(source, /api\.addressBooks\.update/);
  assert.match(source, /onImportVCard/);
});

test('manager keeps provider synchronization account-scoped and DAV-aware', async () => {
  const source = await read('ContactsBooksManager.tsx');
  assert.match(source, /syncAccountProviderFeature/);
  assert.match(source, /carddav/);
  assert.match(source, /api\.carddav\.sync/);
  assert.match(source, /api\.carddav\.disconnect/);
});
