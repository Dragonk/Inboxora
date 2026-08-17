import { describe, expect, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

it('conversation list uses repository-compatible test tooling and async states', () => {
  const source = fs.readFileSync(new URL('./ConversationList.jsx', import.meta.url), 'utf8');
  assert.match(source, /role="status"/);
  assert.match(source, /aria-expanded/);
  assert.match(source, /setError\(null\)/);
});
