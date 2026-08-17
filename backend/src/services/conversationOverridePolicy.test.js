import { describe, expect, it, vi } from 'vitest';
import { effectiveConversationOverride, resolveConversationAlias } from './conversationOverridePolicy.js';

describe('conversation override policy', () => {
  it('selects the newest override per type', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [
      { override_type: 'lock-conversation', target_id: null },
      { override_type: 'lock-conversation', target_id: 'old' },
      { override_type: 'force-exclude', target_id: null },
    ] }) };
    await expect(effectiveConversationOverride(client, { userId: 'u', conversationId: 'c' })).resolves.toMatchObject({ locked: true, forceExclude: { override_type: 'force-exclude' } });
  });

  it('rejects alias cycles', async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ canonical_conversation_id: 'b' }] })
      .mockResolvedValueOnce({ rows: [{ canonical_conversation_id: 'a' }] }) };
    await expect(resolveConversationAlias(client, { userId: 'u', conversationId: 'a' })).rejects.toThrow('cycle');
  });
});
