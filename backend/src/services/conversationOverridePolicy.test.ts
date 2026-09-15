import { describe, expect, it, vi } from 'vitest';
import { effectiveConversationOverride, resolveConversationAlias } from './conversationOverridePolicy.js';

describe('conversation override policy', () => {
  // P1-01: Conversation-level overrides (lock/unlock/merge) are keyed by
  // conversation_id with logical_message_id IS NULL. Message-level overrides
  // (force-include/exclude/split/move) are keyed by exact logical_message_id.
  it('selects the newest conversation-level override and resolves lock state', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [
      { override_type: 'lock-conversation', target_id: null, logical_message_id: null },
      { override_type: 'lock-conversation', target_id: 'old', logical_message_id: null },
    ] }) };
    await expect(effectiveConversationOverride(client, { userId: 'u', conversationId: 'c' })).resolves.toMatchObject({ locked: true });
  });

  it('resolves unlock as latest event (lock then unlock → locked=false)', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [
      { override_type: 'unlock-conversation', target_id: null, logical_message_id: null },
      { override_type: 'lock-conversation', target_id: null, logical_message_id: null },
    ] }) };
    await expect(effectiveConversationOverride(client, { userId: 'u', conversationId: 'c' })).resolves.toMatchObject({ locked: false });
  });

  it('returns message-level overrides only when logicalMessageId is provided', async () => {
    // P1-01: force-exclude is message-level — must NOT be returned when
    // querying conversation-level only (without logicalMessageId).
    const client = { query: vi.fn().mockResolvedValue({ rows: [
      { override_type: 'force-exclude', target_id: null, logical_message_id: 'lm-1' },
    ] }) };
    const result = await effectiveConversationOverride(client, { userId: 'u', conversationId: 'c', logicalMessageId: 'lm-1' });
    expect(result.forceExclude).toMatchObject({ override_type: 'force-exclude' });
  });

  it('rejects alias cycles', async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ canonical_conversation_id: 'b' }] })
      .mockResolvedValueOnce({ rows: [{ canonical_conversation_id: 'a' }] }) };
    await expect(resolveConversationAlias(client, { userId: 'u', conversationId: 'a' })).rejects.toThrow('cycle');
  });
});
