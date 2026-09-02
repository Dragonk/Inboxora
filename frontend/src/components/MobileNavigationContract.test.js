import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mailAppPath = new URL('./MailApp.jsx', import.meta.url);
const contactsPath = new URL('./ContactsPage.jsx', import.meta.url);
const messageListPath = new URL('./MessageList.jsx', import.meta.url);

test('mobile navigation keeps Mail, Contacts, and Calendar reachable from every primary view', async () => {
  const source = await readFile(mailAppPath, 'utf8');

  assert.match(source, /function MobileNavigation\(/);
  assert.match(source, /data-testid="mobile-primary-nav"/);
  assert.match(source, /setShowContacts\(false\);\s*setShowCalendar\(false\)/);
  assert.match(source, /setShowContacts\(true\);\s*setShowCalendar\(false\)/);
  assert.match(source, /setShowContacts\(false\);\s*setShowCalendar\(true\)/);
});

test('mobile mail and contacts creation controls clear the persistent bottom navigation', async () => {
  const [mailApp, contacts, messageList] = await Promise.all([
    readFile(mailAppPath, 'utf8'),
    readFile(contactsPath, 'utf8'),
    readFile(messageListPath, 'utf8'),
  ]);

  assert.match(mailApp, /--mobile-nav-height': '72px'/);
  assert.match(messageList, /bottom: 'calc\(var\(--mobile-nav-height\) \+ var\(--sab\) \+ 20px\)'/);
  assert.match(contacts, /data-testid="contacts-mobile-fab"/);
  assert.match(contacts, /bottom: 'calc\(var\(--mobile-nav-height\) \+ var\(--sab\) \+ 20px\)'/);
});

test('mobile contact navigation invalidates stale detail requests', async () => {
  const contacts = await readFile(contactsPath, 'utf8');

  assert.match(contacts, /contactSelectionRequestRef\.current \+= 1/);
  assert.match(contacts, /requestId !== contactSelectionRequestRef\.current/);
});
