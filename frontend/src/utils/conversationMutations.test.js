import test from 'node:test';
import assert from 'node:assert/strict';
import { removePhysicalCopy } from './conversationMutations.js';

test('removePhysicalCopy retains a logical message while another physical copy remains', () => {
  const messages = [{
    id: 'logical-1',
    copies: [
      { id: 'copy-inbox', accountId: 'account-1' },
      { id: 'copy-archive', accountId: 'account-2' },
    ],
  }];

  assert.deepEqual(removePhysicalCopy(messages, 'logical-1', 'copy-inbox'), [{
    id: 'logical-1',
    copies: [{ id: 'copy-archive', accountId: 'account-2' }],
  }]);
});

test('removePhysicalCopy removes a logical message when its final copy is removed', () => {
  assert.deepEqual(removePhysicalCopy([{ id: 'logical-1', copies: [{ id: 'copy-1' }] }], 'logical-1', 'copy-1'), []);
});
