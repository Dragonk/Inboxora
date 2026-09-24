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

test('provider books are grouped by their account connection', async () => {
  const source = await read(manager);
  assert.match(source, /function groupBooksByConnection/);
  assert.match(source, /const id = `\$\{book\.source\}:\$\{account \?\? 'local'\}`/);
  assert.match(source, /data-testid="contacts-manager-book-group"/);
});

test('CardDAV connection management is separate from the selected book detail', async () => {
  const source = await read(manager);
  const detailEnd = source.indexOf('  ) : (\n    <p data-testid="contacts-manager-detail"');
  const sources = source.indexOf('data-testid="contacts-manager-sources"');
  assert.ok(sources > detailEnd, 'CardDAV sources must not be rendered inside a selected book detail');
});

test('the manager is a dialog with a book list and the selected book beside it', async () => {
  const source = await read(manager);

  // A real dialog, not a menu.
  assert.match(source, /<Dialog/);
  assert.match(source, /testId="contacts-books-manager"/);
  assert.match(source, /data-testid="contacts-manager-books"/);
  assert.match(source, /data-testid="contacts-manager-detail"/);
  assert.match(source, /accountLabel: string \| null;/);
  assert.match(source, /data-testid="contacts-manager-account"/);
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
  // The control names its target, which is the provider for a provider book and the DAV source for a DAV book
  // (DAV-05); a provider authorization is still never started from here.
  assert.match(source, /contacts-manager-sync-\$\{syncTarget\}/);
  assert.match(source, /syncTarget: 'google' \| 'microsoft' \| 'dav' \| null/);
  assert.ok(!source.includes('contacts-manager-connect-google'));
  assert.ok(!source.includes('contacts-manager-connect-microsoft'));
});

test('a CardDAV book is synchronised by its own source, not shown as never synced', async () => {
  // DAV-05: the panel only knew about Google and Microsoft, so a CardDAV book said "never" and offered no
  // action even when the source had just synchronised it.
  const source = await read(manager);
  assert.match(source, /const isDavBook = selected\?\.source === 'carddav' \|\| selected\?\.source === 'dav'/);
  assert.match(source, /props\.dav\.connected \? 'dav' : null/);
  const contactsPage = await read(page);
  // The page takes the DAV source's own status, and its last sync is what the book reports.
  assert.match(contactsPage, /api\.carddav\.status\(\)/);
  assert.match(contactsPage, /admin\.integrations\.carddav\.lastSync/);
  assert.match(contactsPage, /connected: davStatus\?\.connected === true/);
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

test('the manager can be closed and reopened', async () => {
  const source = await read(manager);
  const page = await read(new URL('./ContactsPage.tsx', import.meta.url));

  // The live bug: the dialog was rendered unconditionally, so `onClose` set the state to closed and the panel
  // stayed on screen — it opened and could not be dismissed. The panel must exist only while it is open, and
  // that early return is what makes every close path effective.
  assert.match(source, /if \(!props\.open\) return null;/);
  assert.match(source, /onClose=\{props\.onClose\}/);
  // The hook runs before the early return, so the render order is stable.
  const hookAt = source.indexOf('const [mobileDetail, setMobileDetail] = React.useState(false);');
  const gateAt = source.indexOf('if (!props.open) return null;');
  assert.ok(hookAt !== -1 && gateAt !== -1 && hookAt < gateAt, 'the state hook must precede the open gate');

  // Every close path reaches the same setter, which flips the state the panel is gated on.
  assert.match(source, /data-testid="contacts-manager-back"/);
  assert.match(source, /<Button onClick=\{props\.onClose\}>/);
  assert.match(page, /const \[booksManagerOpen, setBooksManagerOpen\] = useState\(false\)/);
  assert.match(page, /onClose=\{\(\) => setBooksManagerOpen\(false\)\}/);
  // Escape and the backdrop are the Dialog's own, and it is the only dialog the manager mounts.
  assert.equal((source.match(/<Dialog/g) ?? []).length, 1);
});

test('the trigger is a compact icon with an accessible name', async () => {
  const source = await read(new URL('./ContactsPage.tsx', import.meta.url));

  assert.match(source, /data-testid="contacts-manage-books"/);
  // An icon button, not a labelled one: a full-width button competed with the book strip for the header.
  assert.ok(!/data-testid="contacts-manage-books"[^>]*>[\s\S]{0,80}\{t\('contacts\.booksManager\.manage'\)\}/.test(source),
    'the trigger must not render its label as text');
  // Accessible name and tooltip carry the meaning the icon cannot.
  assert.match(source, /aria-label=\{t\('contacts\.booksManager\.manage'\)\}/);
  assert.match(source, /title=\{t\('contacts\.booksManager\.manage'\)\}/);
  assert.match(source, /aria-haspopup="dialog"/);
  // Desktop compact, mobile a real touch target.
  assert.match(source, /width: isMobile \? 44 : 34/);
  assert.match(source, /height: isMobile \? 44 : 34/);
  assert.match(source, /<svg width=\{isMobile \? 20 : 17\}/);
});

test('the CardDAV source is managed from Contacts, like a calendar source', async () => {
  const booksManager = await read(manager);
  const davSource = await read(new URL('./ContactsDavSource.tsx', import.meta.url));

  // The calendar screen adds its own sources from the calendar surface; the contacts source belongs here for
  // the same reason, and the manager exposes it beside the books it pulls.
  assert.match(booksManager, /data-testid="contacts-manager-sources"/);
  // The source also reports back when it changes what it holds, so the books list is reloaded after a connect or
  // a sync instead of staying stale (DAV-01).
  assert.match(booksManager, /<ContactsDavSource t=\{t\} onChanged=\{props\.onDavChanged\} \/>/);
  assert.match(davSource, /onChanged\?: \(\) => void \| Promise<void>/);
  assert.match(davSource, /await onChanged\?\.\(\)/);
  // And the page reloads the books it shows when that happens.
  assert.match(await read(page), /onDavChanged=\{async \(\) => \{/);
  assert.match(await read(page), /await loadAddressBooks\(\);\s*\n\s*await load\(searchRef\.current\);/);

  // It can be added, synchronised and removed — the three things the settings screen offered.
  assert.match(davSource, /data-testid="contacts-manager-carddav-connect"/);
  assert.match(davSource, /data-testid="contacts-manager-carddav-sync"/);
  assert.match(davSource, /data-testid="contacts-manager-carddav-disconnect"/);
  assert.match(davSource, /api\.carddav\.connect\(/);
  assert.match(davSource, /api\.carddav\.sync\(\)/);
  assert.match(davSource, /api\.carddav\.disconnect\(\)/);
  // The credentials are the source's own, and the password is never rendered back.
  assert.match(davSource, /type="password"/);
  const rendered = davSource.slice(davSource.indexOf('return ('));
  assert.ok(!/status\.password/.test(rendered), 'the stored password must not be rendered');
});
