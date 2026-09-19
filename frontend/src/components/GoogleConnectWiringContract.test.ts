import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const adminPanel = new URL('./AdminPanel.tsx', import.meta.url);
const mailApp = new URL('./MailApp.tsx', import.meta.url);
const contactsPage = new URL('./ContactsPage.tsx', import.meta.url);
const localesDir = new URL('../locales/', import.meta.url);

test('the Google provider card offers an account connection once the browser flow is ready', async () => {
  const source = await readFile(adminPanel, 'utf8');
  assert.match(source, /data-testid="google-connect"/);
  assert.match(source, /const handleConnectGoogle = \(\) => \{/);
  // Contacts is the feature that exists today; the purpose decides the scopes asked for.
  assert.match(source, /a\.href = '\/oauth\/google\?purpose=contacts_enable'/);
  assert.match(source, /googleStatus\?\.browser\?\.ready \? \(/);
  assert.match(source, /admin\.integrations\.google\.connectUnavailable/);
  // A completed popup flow updates the Google card (no mailbox is created).
  assert.match(source, /e\.data\?\.provider === 'google'/);
  assert.match(source, /admin\.integrations\.google\.connectedNote/);
  assert.match(source, /setConnectingGoogle\(false\)/);
});

test('a same-tab Google callback reports the connection instead of opening the accounts screen', async () => {
  const source = await readFile(mailApp, 'utf8');
  // Microsoft creates a mailbox and still opens Accounts; Google must not.
  assert.match(source, /if \(provider === 'google'\) \{/);
  assert.match(source, /contacts\.googleConnected\.title/);
  assert.match(source, /contacts\.googleConnected\.body/);
});

test('the contacts screen offers the Google pull only when connected', async () => {
  const source = await readFile(contactsPage, 'utf8');
  assert.match(source, /api\.googleContacts\.status\(\)/);
  assert.match(source, /data-testid="contacts-google-sync"/);
  assert.match(source, /const runGoogleContactsSync = async \(\) => \{/);
  assert.match(source, /await api\.googleContacts\.sync\(\)/);
  assert.match(source, /googleContacts\?\.connected &&/);
  // The result is reported per run, including a partial failure.
  assert.match(source, /contacts\.addressBooks\.googleSyncDone/);
  assert.match(source, /contacts\.addressBooks\.googleSyncPartial/);
  assert.match(source, /data-testid="contacts-google-sync-result"/);
});

test('every locale translates the Google connect and sync controls', async () => {
  const files = (await readdir(localesDir)).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 9);
  const adminKeys = ['connect', 'connecting', 'connectHint', 'connectUnavailable', 'connectedNote'];
  const bookKeys = ['googleSync', 'googleSyncing', 'googleSyncDone', 'googleSyncPartial'];
  for (const name of files) {
    const strings = JSON.parse(await readFile(new URL(name, localesDir), 'utf8'));
    for (const key of adminKeys) {
      assert.equal(typeof strings.admin.integrations.google[key], 'string', `${name} is missing admin.integrations.google.${key}`);
      assert.ok(strings.admin.integrations.google[key].length > 0, `${name} has an empty ${key}`);
    }
    for (const key of bookKeys) {
      assert.equal(typeof strings.contacts.addressBooks[key], 'string', `${name} is missing contacts.addressBooks.${key}`);
      assert.ok(strings.contacts.addressBooks[key].length > 0, `${name} has an empty ${key}`);
    }
    assert.equal(typeof strings.contacts.googleConnected.title, 'string', `${name} is missing contacts.googleConnected.title`);
    assert.equal(typeof strings.contacts.googleConnected.body, 'string', `${name} is missing contacts.googleConnected.body`);
    // The sync summary interpolates with i18next syntax.
    assert.match(strings.contacts.addressBooks.googleSyncDone, /\{\{created\}\}/, `${name} googleSyncDone has no placeholders`);
  }
});
