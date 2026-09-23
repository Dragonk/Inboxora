import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
Object.assign(globalThis, {
  localStorage: storage,
  window: { history: { state: null, pushState: () => {}, replaceState: () => {}, back: () => {} }, addEventListener: () => {}, removeEventListener: () => {} },
});

describe('conversationCopyView reply metadata', () => {
  it('preserves physical RFC reply fields instead of dropping them at reader rendering', async () => {
    const { conversationCopyView } = await import('./ConversationMessage.tsx');
    const copy = conversationCopyView({
      id: 'physical-copy', account_id: 'account-1', message_id: '<child@example.test>',
      in_reply_to: '<parent@example.test>', thread_references: '<root@example.test> <parent@example.test>',
      reply_to: [{ email: 'reply@example.test' }, { email: 'ignored@example.test' }],
    });

    assert.equal(copy.id, 'physical-copy');
    assert.equal(copy.message_id, '<child@example.test>');
    assert.equal(copy.in_reply_to, '<parent@example.test>');
    assert.equal(copy.thread_references, '<root@example.test> <parent@example.test>');
    assert.deepEqual(copy.reply_to, [{ email: 'reply@example.test' }, { email: 'ignored@example.test' }]);
  });
});
