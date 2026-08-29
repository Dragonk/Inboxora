import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { accountOwnAddresses, directionFromAddress, physicalCopyDirection, preferredAccountCopy } from './conversationDirection.js';

const gmail = { id: 'gmail', email_address: 'me@gmail.test', aliases: [{ email: 'alias@gmail.test' }] };

describe('account-local conversation direction', () => {
  it('classifies from only the physical copy account identities', () => {
    assert.equal(physicalCopyDirection({ accountId: 'gmail', fromEmail: 'me@gmail.test' }, gmail), 'outgoing');
    assert.equal(physicalCopyDirection({ accountId: 'gmail', fromEmail: 'me@outlook.test' }, gmail), 'incoming');
    assert.equal(physicalCopyDirection({ accountId: 'outlook', fromEmail: 'me@outlook.test' }, gmail), null);
  });

  it('includes only that account aliases and copy-local delivery identities', () => {
    const own = accountOwnAddresses(gmail, { deliveryAddresses: ['Delivered <catchall@gmail.test>'] });
    assert.equal(directionFromAddress('alias@gmail.test', own), 'outgoing');
    assert.equal(directionFromAddress('catchall@gmail.test', own), 'outgoing');
    assert.equal(directionFromAddress('me@outlook.test', own), 'incoming');
  });

  it('keeps the resolver-selected copy when it belongs to the selected account', () => {
    const message = { copies: [
      { id: 'gmail-old', accountId: 'gmail', date: '2026-01-01' },
      { id: 'gmail-selected', accountId: 'gmail', date: '2025-01-01' },
      { id: 'outlook-new', accountId: 'outlook', date: '2027-01-01' },
    ] };
    assert.equal(preferredAccountCopy(message, 'gmail', 'gmail-selected').id, 'gmail-selected');
    assert.equal(preferredAccountCopy(message, 'gmail', 'outlook-new').id, 'gmail-old');
    assert.equal(preferredAccountCopy(message, 'missing'), null);
  });
});
