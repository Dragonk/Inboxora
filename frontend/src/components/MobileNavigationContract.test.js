import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = path => readFile(new URL(path, import.meta.url), 'utf8');

test('mobile drawer keeps Mail, Contacts, and Calendar mutually exclusive and reachable', async () => {
  const [sidebar, store, app] = await Promise.all([
    source('./Sidebar.jsx'),
    source('../store/index.js'),
    source('./MailApp.jsx'),
  ]);

  assert.match(sidebar, /testId="contacts-nav-mobile"/);
  assert.match(sidebar, /testId="calendar-nav-mobile"/);
  assert.match(store, /setShowContacts: \(showContacts\) => set\(\{ showContacts, \.\.\.\(showContacts \? \{ showCalendar: false \} : \{\}\) \}\)/);
  assert.match(store, /setShowCalendar: \(showCalendar\) => set\(\{ showCalendar, \.\.\.\(showCalendar \? \{ showContacts: false \} : \{\}\) \}\)/);
  assert.match(app, /data-testid="mobile-contacts-page"/);
  assert.match(app, /data-testid="mobile-calendar-page"/);
});

test('mobile mail and contacts actions clear a bottom navigation bar and terminal rows', async () => {
  const [contacts, messages] = await Promise.all([
    source('./ContactsPage.jsx'),
    source('./MessageList.jsx'),
  ]);

  assert.match(contacts, /data-testid="contacts-mobile-fab"/);
  assert.match(contacts, /data-testid="contacts-list-scroll"/);
  assert.match(contacts, /mobileNavigationPosition === 'bottom'/);
  assert.match(contacts, /paddingBottom: isMobile \? 88 : 0/);
  assert.match(messages, /data-testid="message-list-scroll"/);
  assert.match(messages, /mobileNavigationPosition === 'bottom'/);
  assert.match(messages, /aria-hidden="true" style=\{\{ height: 84 \}\}/);
});
