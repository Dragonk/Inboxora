import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The address-book manager, and the absence of the `⋯` menu it replaced.
 *
 * The old control was a `<details>` whose summary was an ellipsis and whose body held a dozen unrelated
 * actions — rename, visibility, write-back, imports, exports, DAV and sync — with no way to tell which book
 * each applied to. The manager is a panel with the books on one side and the selected book's settings on the
 * other, which is the shape the calendar settings already use. These cases pin that shape, the sections, the
 * difference between a local book and a provider collection, and that nothing about it can overflow a narrow
 * screen.
 */

const page = new URL('./ContactsPage.tsx', import.meta.url);
const manager = new URL('./ContactsBooksManager.tsx', import.meta.url);

const read = (url: URL) => readFile(url, 'utf8');

test('the ellipsis menu is gone and one manage action opens the manager', async () => {
  const source = await read(page);

  // The management UI must not be a dropdown any more.
  assert.ok(!source.includes('contacts-book-menu'), 'the ellipsis menu class is still rendered');
  assert.ok(!source.includes('contacts-book-actions'), 'the menu action container is still rendered');
  assert.ok(!/<summary[^>]*>⋯<\/summary>/.test(source), 'the ⋯ summary is still rendered');

  // One entry point, which opens the panel rather than a menu.
  assert.match(source, /data-testid="contacts-manage-books"/);
  assert.match(source, /setBooksManagerOpen\(true\)/);
  assert.match(source, /<ContactsBooksManager/);
});

test('the manager is a dialog with a book list and the selected book beside it', async () => {
  const source = await read(manager);

  // A real dialog, not a menu.
  assert.match(source, /<Dialog/);
  assert.match(source, /testId="contacts-books-manager"/);
  assert.match(source, /data-testid="contacts-manager-books"/);
  assert.match(source, /data-testid="contacts-manager-detail"/);
  assert.ok(!source.includes('<details'), 'the manager must not use a <details> disclosure');

  // Each row states what the book is, so an action can be read in context.
  for (const attribute of ['data-source', 'data-visible', 'data-readonly']) {
    assert.ok(source.includes(attribute), `a book row does not carry ${attribute}`);
  }
  assert.match(source, /contacts-manager-book-\$\{book\.id\}/);
});

test('the manager has every section the panel promises', async () => {
  const source = await read(manager);

  for (const testId of [
    'contacts-manager-general',
    'contacts-manager-sync',
    'contacts-manager-writeback',
    'contacts-manager-dav',
    'contacts-manager-import-export',
    'contacts-manager-danger',
  ]) {
    assert.ok(source.includes(`data-testid="${testId}"`), `${testId} is missing`);
  }

  // The actions live inside their own section, not in one list.
  assert.match(source, /data-testid="contacts-manager-rename"/);
  assert.match(source, /data-testid="contacts-manager-visibility"/);
  assert.match(source, /data-testid="contacts-manager-write-back"/);
  assert.match(source, /data-testid="contacts-manager-dav-mode"/);
  assert.match(source, /data-testid="contacts-manager-import-google"/);
  assert.match(source, /data-testid="contacts-manager-import-vcard"/);
  assert.match(source, /data-testid="contacts-manager-export-google"/);
  assert.match(source, /data-testid="contacts-manager-export-outlook"/);
  assert.match(source, /data-testid="contacts-manager-export-vcard"/);
  // Import and export formats the user asked for, by name.
  assert.match(source, /exportUrl\('google-csv'\)/);
  assert.match(source, /exportUrl\('outlook-csv'\)/);
  assert.match(source, /exportUrl\('vcard'\)/);
});

test('a provider collection and a local book do not offer each other actions', async () => {
  const source = await read(manager);

  // Rename, delete and DAV are local-only; a provider collection says so instead of pretending.
  assert.match(source, /const isLocal = selected\?\.source === 'local'/);
  assert.match(source, /isLocal && <Button data-testid="contacts-manager-rename"/);
  assert.match(source, /canDelete = props\.canDelete && isLocal/);
  assert.match(source, /contacts-manager-dav-unavailable/);
  // The last local book cannot be deleted.
  assert.match(source, /localBooks\.length > 1/);
  assert.match(source, /contacts-manager-delete-blocked/);
});

test('the manager never starts a provider authorization', async () => {
  const source = await read(manager);

  // Connecting Google or Microsoft contacts is account-scoped and stays on the mailbox card; the panel only
  // synchronises and explains where to connect.
  assert.ok(!source.includes('/oauth/'), 'the manager must not link an OAuth flow');
  assert.ok(!source.includes('authorizationPath'));
  assert.match(source, /contacts-manager-connect-hint/);
  assert.match(source, /contacts-manager-sync-\$\{provider\}/);
  assert.ok(!source.includes('contacts-manager-connect-google'));
  assert.ok(!source.includes('contacts-manager-connect-microsoft'));
});

test('the manager is one panel on desktop and a two-step sheet on mobile', async () => {
  const source = await read(manager);

  // Mobile: the list, then the detail with a Back action; no side-by-side squeeze.
  assert.match(source, /isMobile \? \{ className: 'ui-sheet' \}/);
  assert.match(source, /data-testid="contacts-manager-back"/);
  assert.match(source, /mobileDetail/);
  // The panes are flexible and allowed to shrink, which is what keeps a 360px screen from scrolling sideways.
  assert.match(source, /flex: isMobile \? '1 1 100%' : '1 1 260px'/);
  assert.match(source, /flex: isMobile \? '1 1 100%' : '2 1 340px'/);
  assert.match(source, /minWidth: 0/);
  assert.match(source, /flexWrap: 'wrap'/);
  // No fixed pixel width that a narrow viewport cannot satisfy.
  assert.ok(!/width: 9\d\d/.test(source), 'a fixed wide layout would overflow a phone');
});

test('both layouts render the manager, so the mobile sheet can open it too', async () => {
  const source = await read(page);
  // `bookControls` is rendered in the mobile header and the desktop header; the manager is rendered once per
  // layout alongside the name dialog.
  const mounts = (source.match(/\{booksManager\}/g) ?? []).length;
  assert.equal(mounts, 2, 'the manager must be mounted in both the mobile and the desktop layout');
});
