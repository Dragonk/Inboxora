import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./ContactsPage.jsx', import.meta.url), 'utf8');

test('contact form preserves arbitrary labelled dates and offers add/remove controls', () => {
  assert.match(source, /contactDates:\s*\[\]/);
  assert.match(source, /selected\.contactDates\?\.length/);
  assert.match(source, /selected\.birthday && \{ label: 'Birthday'/);

  assert.match(source, /contactDates:\s*form\.contactDates/);
  assert.match(source, /onAddCollection\('contactDates'/);
  assert.match(source, /onRemoveCollection\('contactDates', index\)/);
});

test('contact date labels support birthday, name day, and custom values', () => {
  assert.match(source, /value="Birthday"/);
  assert.match(source, /value="Name day"/);
  assert.match(source, /value="custom"/);
});
