import { describe, expect, it, vi } from 'vitest';
import { effectiveConversationOverride } from './conversationOverridePolicy.js';

describe('authoritative manual override precedence', () => {
  it('returns force-exclude and split independently so callers can apply explicit precedence', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [
      { override_type: 'manual-split', target_id: 'split-target' },
      { override_type: 'force-exclude', target_id: null },
      { override_type: 'lock-conversation', target_id: null },
    ] }) };
    const result = await effectiveConversationOverride(client, { userId: 'u', conversationId: 'c', logicalMessageId: 'm' });
    expect(result.split.target_id).toBe('split-target');
    expect(result.forceExclude).toBeTruthy();
    expect(result.locked).toBe(true);
  });
});
