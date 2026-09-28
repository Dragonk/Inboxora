import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initialComposeSender } from './composeSender.ts';

const accounts = [
  { id: 'a', default_alias_id: 'work', aliases: [{ id: 'work', email: 'work@example.test' }, { id: 'billing', email: 'billing@example.test' }] },
  { id: 'b', default_alias_id: 'other', aliases: [{ id: 'other', email: 'other@example.test' }] },
];
const select = (draft = {}, selectedAccountId: string | null = null) => initialComposeSender({ accounts, draft, selectedAccountId });

describe('initialComposeSender', () => {
  it('uses the configured default per account for new messages and forwards', () => {
    assert.equal(select({ accountId: 'a' }), 'alias:work:a');
    assert.equal(select({ accountId: 'b' }), 'alias:other:b');
    assert.equal(select({ accountId: 'a', isForward: true }), 'alias:work:a');
    assert.equal(select({}, 'b'), 'alias:other:b');
  });
  it('retains explicit aliases and primary selections regardless of the default', () => {
    assert.equal(select({ accountId: 'a', aliasId: 'billing' }), 'alias:billing:a');
    assert.equal(select({ accountId: 'a', aliasId: null }), 'account:a');
  });
  it('never replaces a reply or reply-all primary identity with the new-message default', () => {
    assert.equal(select({ accountId: 'a', isReply: true }), 'account:a');
    assert.equal(select({ accountId: 'a', isReplyAll: true }), 'account:a');
    assert.equal(select({ accountId: 'a', isReply: true, aliasId: 'billing' }), 'alias:billing:a');
  });
  it('preserves saved draft identities, including primary and unavailable aliases', () => {
    assert.equal(select({ accountId: 'a', draftUid: 4 }), 'account:a');
    assert.equal(select({ accountId: 'a', draftRowId: 'draft' }), 'account:a');
    assert.equal(select({ accountId: 'a', draftUid: 4, aliasId: 'removed' }), 'alias:removed:a');
  });
  it('falls back only for a missing, foreign or unusable configured default', () => {
    for (const default_alias_id of [null, undefined, 'missing', 'other']) {
      assert.equal(initialComposeSender({ accounts: [{ ...accounts[0], default_alias_id }] }), 'account:a');
    }
    assert.equal(initialComposeSender({ accounts: [{ id: 'a', default_alias_id: 'blank', aliases: [{ id: 'blank', email: ' ' }] }] }), 'account:a');
  });
  it('uses valid current/last accounts and never a remembered foreign account', () => {
    assert.equal(initialComposeSender({ accounts, lastUsedAccountId: 'b' }), 'alias:other:b');
    assert.equal(initialComposeSender({ accounts, selectedAccountId: 'gone', lastUsedAccountId: 'b' }), 'alias:other:b');
    assert.equal(initialComposeSender({ accounts, selectedAccountId: 'a', lastUsedAccountId: 'b' }), 'alias:work:a');
    assert.equal(initialComposeSender({ accounts, lastUsedAccountId: 'gone' }), 'alias:work:a');
    assert.equal(initialComposeSender({ accounts: [] }), '');
  });
});
