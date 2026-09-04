import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./ContactsPage.jsx', import.meta.url), 'utf8');

test('desktop Contacts uses the shared Mail list width and fills its detail pane', () => {
  assert.match(source, /data-testid="contacts-desktop-list"[\s\S]*?flex: ['"]0 0 var\(--list-width\)['"][\s\S]*?width: ['"]var\(--list-width\)['"]/);
  assert.match(source, /data-testid="contacts-desktop-detail"[\s\S]*?flex: 1/);
  assert.doesNotMatch(source, /maxWidth: 560/);
});

test('mobile Contacts reserves space between the final row, FAB, and bottom navigation', () => {
  assert.match(source, /paddingBottom: isMobile \? 'calc\(var\(--mobile-nav-height\) \+ var\(--sab\) \+ 88px\)'/);
  assert.match(source, /bottom: 'calc\(var\(--mobile-nav-height\) \+ var\(--sab\) \+ 20px\)'/);
});

test('contact detail renders imported events as contact dates without exposing raw Google CSV columns', () => {
  assert.match(source, /const contactDates = c\.contactDates\?\.length/);
  assert.match(source, /\{contactDates\.map\(\(date, i\)/);
  assert.doesNotMatch(source, /Object\.entries\(c\.googleFields \|\| \{\}\)\.map/);
});
