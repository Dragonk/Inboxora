import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

test('reply ingest diagnostics are isolated from successful Conversation persistence', async () => {
  const source = await readFile(new URL('./conversationRowIngest.ts', import.meta.url), 'utf8');
  const diagnostic = source.slice(
    source.indexOf('// Diagnostic observation must never downgrade'),
    source.indexOf('  } catch (caught) {'),
  );

  expect(diagnostic).toMatch(/try \{\s*const parentHeader/);
  expect(diagnostic).toMatch(/catch \(diagnosticError\)/);
  expect(diagnostic).toMatch(/Reply ingest diagnostic failed/);
  expect(diagnostic).not.toMatch(/recordConversationIngestFailure/);
});
