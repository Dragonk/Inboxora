import { describe, expect, it, vi } from 'vitest';
import { conversationViewEnabled, ensureConversationFeatureDefaults } from './conversationPreferences.js';

vi.mock('./db.js', () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
import { query as __mock_query } from './db.js';

const query = vi.mocked(__mock_query);

describe('conversation feature preferences', () => {
  it('keeps list and reader flags independent', () => {
    expect(conversationViewEnabled({ conversation_list_view_enabled: true }, 'conversation_list_view_enabled')).toBe(true);
    expect(conversationViewEnabled({ conversation_list_view_enabled: true }, 'conversation_reader_view_enabled')).toBe(false);
  });

  it('initializes missing server-side defaults without overwriting existing values', async () => {
    await ensureConversationFeatureDefaults('user-1');
    const call = query.mock.calls.at(-1);
    expect(call).toBeDefined();
    if (call === undefined) {
      throw new Error('Expected ensureConversationFeatureDefaults to query the database');
    }

    const [sql, params] = call;
    expect(sql).toContain('$2');
    expect(params).toEqual(['user-1', 'conversation_list_view_enabled', 'conversation_reader_view_enabled']);
  });
});
