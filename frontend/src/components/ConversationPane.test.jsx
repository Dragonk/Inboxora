import { describe, expect, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

it('conversation pane has accessible lazy loading states and target support', () => {
  const source = fs.readFileSync(new URL('./ConversationPane.jsx', import.meta.url), 'utf8');
  assert.match(source, /Loading conversation/);
  assert.match(source, /targetLogicalMessageId/);
  assert.match(source, /aria-expanded/);
});
