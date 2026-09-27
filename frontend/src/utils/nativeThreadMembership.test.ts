import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isExpandableNativeThread, nativeThreadCacheMatchesRow, normalizedNativeThreadMembers, singletonNativeThreadTarget } from './nativeThreadMembership.ts';

describe('normalized native thread membership', () => {
  it('treats duplicate physical copies of one normalized message as a singleton', () => {
    const row = { id: 'copy-inbox', message_id: '<same@example.test>' };
    const members = normalizedNativeThreadMembers([row, { id: 'copy-all-mail', message_id: '<same@example.test>' }]);
    assert.deepEqual(members.map(member => member.id), ['copy-inbox']);
    assert.equal(isExpandableNativeThread(members), false);
    const target = singletonNativeThreadTarget(row, members);
    assert.ok(target);
    assert.equal(target.id, 'copy-inbox');
  });

  it('keeps distinct normalized messages expandable', () => {
    const members = normalizedNativeThreadMembers([
      { id: 'one', message_id: '<one@example.test>' },
      { id: 'two', message_id: '<two@example.test>' },
    ]);
    assert.equal(isExpandableNativeThread(members), true);
  });
});


describe('native thread cache freshness', () => {
  const members = Array.from({ length: 17 }, (_, i) => ({ id: `copy-${i}`, message_id: `<mail-${i}>`, account_id: 'a' }));
  const row = { ...members[16], message_count: 17 };
  it('rejects 14 cached children when the parent advertises 17', () => {
    assert.equal(nativeThreadCacheMatchesRow(row, members.slice(0, 14)), false);
    assert.equal(nativeThreadCacheMatchesRow(row, members), true);
  });
  it('rejects missing membership and a replacement head with the same count', () => {
    assert.equal(nativeThreadCacheMatchesRow(row, undefined), false);
    assert.equal(nativeThreadCacheMatchesRow(row, []), false);
    assert.equal(nativeThreadCacheMatchesRow({ ...row, id: 'new', message_id: '<new>' }, members), false);
  });
  it('accepts the same normalized head in another folder without an exact physical copy', () => {
    assert.equal(nativeThreadCacheMatchesRow({ ...row, id: 'another-folder-copy' }, members), true);
  });
  it('never reuses membership from another account', () => {
    assert.equal(nativeThreadCacheMatchesRow({ ...row, account_id: 'b' }, members), false);
  });
  it('rejects stale surplus membership when messages were removed', () => {
    assert.equal(nativeThreadCacheMatchesRow({ ...row, message_count: 14 }, members), false);
  });
  it('has no page-sized cap and supports legacy rows without a count', () => {
    const large = Array.from({ length: 101 }, (_, i) => ({ id: `large-${i}` }));
    assert.equal(normalizedNativeThreadMembers(large).length, 101);
    assert.equal(nativeThreadCacheMatchesRow({ ...large[100], message_count: 101 }, large), true);
    assert.equal(nativeThreadCacheMatchesRow(members[16], members), true);
  });
});
