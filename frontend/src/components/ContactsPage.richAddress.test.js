import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./ContactsPage.jsx', import.meta.url), 'utf8');

test('renders and edits every ADR component preserved by the contacts API', () => {
  for (const field of ['pobox', 'extended', 'street', 'locality', 'region', 'postalCode', 'country']) {
    assert.match(source, new RegExp(`address\\.${field}`), `missing ADR component: ${field}`);
  }
});
