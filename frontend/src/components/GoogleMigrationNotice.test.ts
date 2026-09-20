import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

/**
 * The recommendation card's migration action.
 *
 * The card must be able to do the thing it recommends: authorize Gmail when the mailbox has no Gmail-scoped
 * grant yet and then move the account in place, refresh the account state on success, and leave both the
 * account and the recommendation untouched when it fails. Suppressing the notice is a separate decision the
 * user makes — never a side effect of a successful or failed migration.
 */

const panel = new URL('./AdminPanel.tsx', import.meta.url);
const api = new URL('../utils/api.ts', import.meta.url);
const locales = new URL('../locales/', import.meta.url);

test('the recommendation offers the migration action beside ignore and never-show-again', async () => {
  const source = await readFile(panel, 'utf8');
  assert.match(source, /data-testid="google-recommendation-migrate"/);
  assert.match(source, /data-testid="google-recommendation-ignore"/);
  assert.match(source, /data-testid="google-recommendation-suppress"/);
  assert.match(source, /onClick=\{\(\) => migrateNoticeAccount\(notice\)\}/);
});

test('the migration authorizes Gmail only when the grant is missing, then migrates that account', async () => {
  const source = await readFile(panel, 'utf8');
  const handler = source.slice(source.indexOf('const migrateNoticeAccount'), source.indexOf('const suppressNotice'));
  // The authorization flow is the Gmail one, and it is only started when the server says there is no grant.
  assert.match(handler, /let ready = notice\.hasGmailGrant === true;/);
  assert.match(handler, /if \(!ready\) \{/);
  assert.match(handler, /'\/oauth\/google\?purpose=mail_migration'/);
  // The grant lands on the server; the card waits for it instead of guessing a delay.
  assert.match(handler, /const data = await loadNotices\(\);/);
  assert.match(handler, /hasGmailGrant === true/);
  // Then the account itself is migrated, by id.
  assert.match(handler, /await api\.migrateAccount\(notice\.accountId\)/);
  // Success refreshes the account list and reloads the notices, which is what clears the recommendation.
  assert.match(handler, /const accounts = await api\.getAccounts\(\);/);
  assert.match(handler, /setAccounts\(accounts\)/);
  assert.match(handler, /await loadNotices\(\)/);
  // A failure reports the error and never suppresses the recommendation.
  assert.doesNotMatch(handler, /suppressNotice/);
  assert.match(handler, /catch \(err\) \{/);
  assert.match(handler, /addNotification\(\{ type: 'error'/);
});

test('ignore stays session-only while never-show-again is durable', async () => {
  const source = await readFile(panel, 'utf8');
  assert.match(source, /onClick=\{\(\) => setIgnoredNotices\(current => \[\.\.\.current, notice\.accountId\]\)\}/);
  assert.match(source, /onClick=\{\(\) => suppressNotice\(notice\.accountId\)\}/);
  const suppress = source.slice(source.indexOf('const suppressNotice'), source.indexOf('// Alias form state'));
  assert.match(suppress, /await api\.suppressNotice\(accountId\)/);
  assert.match(suppress, /setNotices\(current => current\.filter/);
});

test('the API client posts the migration to the account it names', async () => {
  const source = await readFile(api, 'utf8');
  assert.match(source, /migrateAccount: \(accountId: string, body: Record<string, unknown> = \{\}\) =>\s*\n\s*request\('POST', `\/accounts\/\$\{encodeURIComponent\(accountId\)\}\/migrate`, body\)/);
});

test('every locale carries the migration copy', async () => {
  const files = (await readdir(locales)).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 9);
  for (const name of files) {
    const raw = await readFile(new URL(name, locales), 'utf8');
    const messages = JSON.parse(raw) as { admin?: { accounts?: Record<string, string> } };
    for (const key of ['googleMigrate', 'googleMigratePending', 'googleMigrateAuthorize', 'googleMigrateSuccess']) {
      const value = messages.admin?.accounts?.[key];
      assert.equal(typeof value, 'string', `${name} is missing admin.accounts.${key}`);
      assert.notEqual(value?.trim(), '', `${name} has an empty admin.accounts.${key}`);
    }
  }
});
