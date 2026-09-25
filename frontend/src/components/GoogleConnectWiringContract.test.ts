import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name: string) => readFile(new URL(`./${name}`, import.meta.url), 'utf8');

test('provider callbacks and account-scoped contact sync remain wired', async () => {
  const [mail, contacts, manager] = await Promise.all([read('MailApp.tsx'), read('ContactsPage.tsx'), read('ContactsBooksManager.tsx')]);
  assert.match(mail, /googleConnected/);
  assert.match(mail, /microsoftGraphConnected/);
  assert.match(contacts, /api\.googleContacts\.status\(\)/);
  assert.match(contacts, /api\.microsoftContacts\.status\(\)/);
  assert.match(contacts, /syncAccountProviderFeature\(accountId, 'contacts'\)/);
  assert.match(manager, /ServiceSettingsView/);
});

test('calendar management syncs the selected source while the rail only navigates', async () => {
  const [calendar, sidebar] = await Promise.all([read('CalendarSettingsManager.tsx'), read('CalendarSidebar.tsx')]);
  assert.match(calendar, /api\.syncAccountProviderFeature\([^\n]+, 'calendars'\)/);
  assert.match(calendar, /api\.calendar\.presentation\(\)/);
  assert.match(sidebar, /openSettings/);
  assert.doesNotMatch(sidebar, /syncAccountProviderFeature/);
});

test('contacts and calendar imports use typed file endpoints', async () => {
  const [contacts, calendar] = await Promise.all([read('ContactsPage.tsx'), read('CalendarSettingsManager.tsx')]);
  assert.match(contacts, /importVCard/);
  assert.match(calendar, /api\.calendar\.importIcs/);
  assert.match(calendar, /accept="\.ics,text\/calendar"/);
});

test('provider and calendar errors render translated status messages', async () => {
  const [contacts, calendar] = await Promise.all([read('ContactsPage.tsx'), read('CalendarSettingsManager.tsx')]);
  assert.match(contacts, /providerFailureKey/);
  assert.match(calendar, /syncFailed/);
  assert.match(calendar, /Notice|setReadFailed|setError/);
});
