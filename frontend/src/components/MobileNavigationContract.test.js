import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mailAppPath = new URL('./MailApp.jsx', import.meta.url);
const contactsPath = new URL('./ContactsPage.jsx', import.meta.url);
const messageListPath = new URL('./MessageList.jsx', import.meta.url);

test('mobile navigation lives in the top bar and the mock-up drawer, not a bottom bar', async () => {
  const source = await readFile(mailAppPath, 'utf8');

  assert.match(source, /function MobileTopBar\(/);
  assert.match(source, /data-testid="mobile-topbar"/);
  assert.match(source, /onMenu={\(\) => setMobileSidebarOpen\(true\)}/);
  assert.match(source, /data-testid="mobile-sidebar"[\s\S]*?zIndex: 1300/);
  assert.doesNotMatch(source, /function MobileNavigation\(/);
  assert.doesNotMatch(source, /data-testid="mobile-primary-nav"/);
  assert.match(source, /'--mobile-nav-height': '0px'/);
});

test('mobile creation controls no longer reserve bottom-bar space', async () => {
  const [mailApp, contacts, messageList] = await Promise.all([
    readFile(mailAppPath, 'utf8'),
    readFile(contactsPath, 'utf8'),
    readFile(messageListPath, 'utf8'),
  ]);

  assert.match(mailApp, /'--mobile-nav-height': '0px'/);
  assert.match(messageList, /bottom: mobileNavigationPosition === 'bottom' \? 'calc\(var\(--sab\) \+ 72px\)' : 'calc\(var\(--sab\) \+ 20px\)'/);
  assert.match(messageList, /<MobileFloatingAction inline/);
  assert.match(contacts, /data-testid="contacts-header-new"/);
  assert.match(mailApp, /position={mobileNavigationPosition}/);
});

test('mobile contact navigation invalidates stale detail requests', async () => {
  const contacts = await readFile(contactsPath, 'utf8');

  assert.match(contacts, /contactSelectionRequestRef\.current \+= 1/);
  assert.match(contacts, /requestId !== contactSelectionRequestRef\.current/);
});
