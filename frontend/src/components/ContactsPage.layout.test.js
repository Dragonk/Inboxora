import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./ContactsPage.jsx', import.meta.url), 'utf8');

test('desktop Contacts uses the shared Mail list width and fills its detail pane', () => {
  assert.match(source, /data-testid="contacts-desktop-list"[\s\S]*?flex: ['"]0 0 var\(--list-width\)['"][\s\S]*?width: ['"]var\(--list-width\)['"]/);
  assert.match(source, /data-testid="contacts-desktop-detail"[\s\S]*?flex: 1/);
  assert.doesNotMatch(source, /maxWidth: 560/);
});

test('desktop Contacts resizes its list with the shared panel handle', () => {
  assert.match(source, /import \{ beginPanelResize \} from '\.\.\/utils\/panelWidth\.js'/);
  assert.match(source, /<PanelResizeHandle testId="contacts-list-resize" onMouseDown=\{handleListResizeMouseDown\} \/>/);
  assert.match(source, /beginPanelResize\(event, \{ edge: 'right' \}\)/);
});

test('mobile Contacts puts creation in the shared header without reserving floating-button space', () => {
  assert.match(source, /data-testid="contacts-header-new"/);
  assert.doesNotMatch(source, /contacts-mobile-fab/);
});

test('contact detail renders imported events as contact dates without exposing raw Google CSV columns', () => {
  assert.match(source, /const contactDates = c\.contactDates\?\.length/);
  assert.match(source, /\{contactDates\.map\(\(date, i\)/);
  assert.doesNotMatch(source, /Object\.entries\(c\.googleFields \|\| \{\}\)\.map/);
});
