import { describe, expect, it } from 'vitest';
import { query } from './db.js';

describe('conversation performance contract', () => {
  it('keeps conversation list query explainable when DB integration is enabled', async () => {
    if (process.env.REQUIRE_DB_PERF_GATE !== '1') return;
    const result = await query(`EXPLAIN (FORMAT JSON) SELECT c.id FROM conversations c JOIN messages m ON m.conversation_id = c.id WHERE c.user_id = $1 LIMIT 50`, ['00000000-0000-0000-0000-000000000000']);
    const plan = JSON.stringify(result.rows);
    expect(plan).toContain('Index');
  });
});
