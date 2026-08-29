import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isExpandableNativeThread, normalizedNativeThreadMembers, singletonNativeThreadTarget } from './nativeThreadMembership.js';

describe('normalized native thread membership', () => {
  it('treats duplicate physical copies of one normalized message as a singleton', () => {
    const row = { id: 'copy-inbox', message_id: '<same@example.test>' };
    const members = normalizedNativeThreadMembers([row, { id: 'copy-all-mail', message_id: '<same@example.test>' }]);
    assert.deepEqual(members.map(member => member.id), ['copy-inbox']);
    assert.equal(isExpandableNativeThread(members), false);
    assert.equal(singletonNativeThreadTarget(row, members).id, 'copy-inbox');
  });

  it('keeps distinct normalized messages expandable', () => {
    const members = normalizedNativeThreadMembers([
      { id: 'one', message_id: '<one@example.test>' },
      { id: 'two', message_id: '<two@example.test>' },
    ]);
    assert.equal(isExpandableNativeThread(members), true);
  });
});
