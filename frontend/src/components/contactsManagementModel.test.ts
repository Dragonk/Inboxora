import assert from 'node:assert/strict';
import test from 'node:test';
import { accountContactsSyncMessage, groupBooksByConnection, initialContactTarget, providerSyncAccount, writableContactTarget } from './contactsManagementModel.ts';

const book = (id: string, accountId: string | null = null, connectionId: string | null = null, source = 'google') => ({ id, accountId, connectionId, source, accountLabel: 'same@example.com' });
test('stable IDs separate identical labels and group collections of one connection', () => {
  const groups = groupBooksByConnection([book('a', 'account-a', 'conn-a'), book('b', 'account-b', 'conn-b'), book('c', 'account-a', 'conn-a')]);
  assert.deepEqual(groups.map(group => group.books.map(row => row.id)), [['a', 'c'], ['b']]);
  assert.equal(groupBooksByConnection([book('a', 'a'), book('b', 'b')]).length, 2);
  assert.equal(groupBooksByConnection([book('a', null, 'a'), book('b', null, 'b')]).length, 2);
});
test('unknown external identities never merge, local books intentionally do', () => {
  for (const source of ['google', 'microsoft', 'carddav', 'unknown']) assert.equal(groupBooksByConnection([book('a', null, null, source), book('b', null, null, source)]).length, 2);
  assert.equal(groupBooksByConnection([book('a', null, null, 'local'), book('b', null, null, 'local')]).length, 1);
});
test('account sync refuses missing or conflicting ownership', () => {
  assert.equal(providerSyncAccount(undefined, 'google'), null);
  assert.equal(providerSyncAccount({ source: 'google', provider: 'google' }, 'google'), null);
  assert.equal(providerSyncAccount({ source: 'google', provider: 'microsoft', account_id: 'b' }, 'google'), null);
  assert.equal(providerSyncAccount({ source: 'google', provider: 'google', account_id: 'a' }, 'google'), 'a');
});
test('new all-visible contact picks writable book but save never reroutes', () => {
  const books = [{ id: 'ro', read_only: true }, { id: 'a', read_only: false }, { id: 'b', read_only: false }];
  assert.equal(initialContactTarget(books, '')?.id, 'a');
  assert.equal(initialContactTarget(books, 'b')?.id, 'b');
  assert.equal(initialContactTarget(books, 'ro')?.id, 'a');
  assert.equal(writableContactTarget(books.slice(2), 'a'), undefined);
  assert.equal(writableContactTarget([{ id: 'a', read_only: true }, books[2]], 'a'), undefined);
  assert.equal(initialContactTarget([books[0]], ''), undefined);
});
const t = (key: string, values?: Record<string, unknown>) => `${key} ${JSON.stringify(values ?? {})}`;
test('HTTP200 success reports actual counts; partial reports all diagnostics', () => {
  assert.match(accountContactsSyncMessage({ state: 'success', result: { created: 2, updated: 3, deleted: 1 } }, 'google', t), /googleSyncDone.*"created":2,"updated":3,"deleted":1/);
  const message = accountContactsSyncMessage({ state: 'partial', result: { created: 2, errors: [{ code: 'INSUFFICIENT_SCOPES', missingScopes: ['Contacts.Read'] }, { code: 'RATE_LIMITED', providerStatus: 429 }] } }, 'microsoft', t);
  assert.match(message, /microsoftSyncPartial.*"created":2.*"failed":2/);
  assert.match(message, /Contacts.Read/);
  assert.match(message, /rateLimited/);
});
test('non-success HTTP200 and malformed responses never claim success', () => {
  for (const state of ['error', 'incomplete', 'skipped_disabled', undefined]) {
    const message = accountContactsSyncMessage({ state }, 'google', t);
    assert.match(message, /googleSyncPartial/);
    assert.doesNotMatch(message, /googleSyncDone/);
  }
  for (const result of [{ error: { code: 'FAILED' } }, { incomplete: true }, { disabled: true }]) {
    assert.match(accountContactsSyncMessage({ state: 'success', result }, 'google', t), /googleSyncPartial/);
  }
});
