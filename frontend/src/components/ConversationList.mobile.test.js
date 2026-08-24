import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./ConversationList.jsx', import.meta.url), 'utf8');

test('mobile long press consumes the synthetic follow-up click', () => {
  assert.match(source, /const longPressTriggered = useRef\(false\)/);
  assert.match(source, /longPressTriggered\.current = true/);
  assert.match(source, /if \(longPressTriggered\.current\)/);
});
