import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Conversation reply uses the selected physical copy as its sole parent id', async () => {
  const source = await readFile(new URL('./MailApp.tsx', import.meta.url), 'utf8');
  assert.match(source, /const selectedCopyId = copy\.selectedCopyId \|\| copy\.id \|\| null/);
  assert.match(source, /id: selectedCopyId,/);
  assert.match(source, /replyToMessageId: selectedCopyId,/);
  assert.doesNotMatch(source, /replyToMessageId: copy\.id,/);
});
