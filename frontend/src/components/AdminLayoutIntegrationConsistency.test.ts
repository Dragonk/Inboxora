import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = () => readFile(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');

test('integration settings keep provider cards collapsed until user interaction', async () => {
  const source = await read();
  assert.match(source, /useState\(false\)/);
  assert.match(source, /aria-expanded=/);
  assert.match(source, /aria-controls=/);
  assert.match(source, /role="tablist"/);
});

test('integration cards use responsive action layout and translated hints', async () => {
  const source = await read();
  assert.match(source, /providerActionsStyle/);
  assert.match(source, /flexWrap: 'wrap'/);
  assert.match(source, /data-testid="google-accounts-only"/);
  assert.match(source, /data-testid="microsoft-accounts-only"/);
});
