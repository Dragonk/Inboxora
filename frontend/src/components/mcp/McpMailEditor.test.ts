import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMcpRecipients } from '../../utils/mcpRecipients.ts';

test('MCP approval recipient input accepts common separators without breaking quoted display names', () => {
  assert.deepEqual(parseMcpRecipients('alice@example.test; bob@example.test\ncarol@example.test'), [
    'alice@example.test', 'bob@example.test', 'carol@example.test',
  ]);
  assert.deepEqual(parseMcpRecipients('"Doe, Jane" <jane@example.test>, other@example.test'), [
    '"Doe, Jane" <jane@example.test>', 'other@example.test',
  ]);
});

test('MCP approval recipient input removes duplicate mailboxes without rewriting authored display names', () => {
  assert.deepEqual(parseMcpRecipients('Jane <jane@example.test>; jane@example.test; OTHER@example.test; other@example.test'), [
    'Jane <jane@example.test>', 'OTHER@example.test',
  ]);
});
