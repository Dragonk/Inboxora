import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The Google mail migration recommendation is a server-side fact with two client-side controls: *Ignore*
 * (the interface forgets it for the session) and *do not show again* (a durable per-user, per-account
 * suppression). These assertions pin that split, because collapsing the two would silently turn the
 * durable one into a session dismissal — and the opposite would make "ignore" permanent.
 */

const adminPanelPath = new URL('./AdminPanel.tsx', import.meta.url);
const apiPath = new URL('../utils/api.ts', import.meta.url);

test('the accounts tab loads the server’s notice list and renders one per account', async () => {
  const source = await readFile(adminPanelPath, 'utf8');
  const start = source.indexOf('function AccountsTab(');
  assert.notEqual(start, -1, 'the accounts tab is missing');
  const tab = source.slice(start, source.indexOf('\nfunction ', start + 1));

  assert.match(tab, /api\.getNotices\(\)/);
  assert.match(tab, /data-testid="google-mail-recommendation"/);
  assert.match(tab, /data-testid="google-recommendation-ignore"/);
  assert.match(tab, /data-testid="google-recommendation-suppress"/);
  // The account's own address is named, so the user knows which mailbox the recommendation is about.
  assert.match(tab, /t\('admin\.accounts\.googleRecommendation', \{ address: notice\.address \}\)/);
});

test('Ignore is session-scoped and do-not-show-again is the server call', async () => {
  const source = await readFile(adminPanelPath, 'utf8');
  const start = source.indexOf('function AccountsTab(');
  const tab = source.slice(start, source.indexOf('\nfunction ', start + 1));

  // Ignore only remembers the account locally; it must not reach the API.
  assert.match(tab, /onClick=\{\(\) => setIgnoredNotices\(current => \[\.\.\.current, notice\.accountId\]\)\}/);
  // Do not show again is the durable call, and it removes the notice only after the server accepted it.
  assert.match(tab, /const suppressNotice = async \(accountId: string\) => \{[\s\S]*?await api\.suppressNotice\(accountId\);[\s\S]*?setNotices\(current => current\.filter/);
  assert.match(tab, /noticeError/);
});

test('the API client targets the notice endpoints the server exposes', async () => {
  const source = await readFile(apiPath, 'utf8');
  assert.match(source, /getNotices: \(\) => request\('GET', '\/integrations\/notices'\)/);
  assert.match(source, /suppressNotice: \(accountId: string\) => request\('POST', `\/integrations\/notices\/\$\{encodeURIComponent\(accountId\)\}\/suppress`, \{\}\)/);
});
