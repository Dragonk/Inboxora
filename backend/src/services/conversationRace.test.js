import { describe, expect, it, vi } from 'vitest';
import { lockConversationsDeterministically } from './conversationOverridePolicy.js';

describe('conversation race gate', () => {
  it('locks conversation ids in deterministic order', async () => {
    const queries = [];
    const client = { query: vi.fn(async (...args) => { queries.push(args); return { rows: [] }; }) };
    const result = await lockConversationsDeterministically(client, 'user', ['b', 'a', 'b']);
    expect(result).toEqual(['a', 'b']);
    expect(queries[0][1]).toEqual(['user', ['a', 'b']]);
  });
});
