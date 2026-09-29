import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mailViewScopeMatches } from './mailViewScope.ts';

test('navigation invalidates a request before passive-effect cleanup, including A to B to A', () => {
  const origin = { authEpoch: 1, selectedAccountId: 'a', selectedFolder: 'INBOX', messagesRefreshToken: 10 };
  assert.equal(mailViewScopeMatches(origin, origin), true);
  for (const change of [{ selectedAccountId: 'b' }, { selectedFolder: 'Sent' }, { authEpoch: 2 },
    { messagesRefreshToken: 12 }, { isLocked: true }]) {
    assert.equal(mailViewScopeMatches({ ...origin, ...change }, origin), false);
  }
});
