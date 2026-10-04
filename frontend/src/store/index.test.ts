import { test } from 'node:test';
import assert from 'node:assert/strict';

Reflect.set(globalThis, 'localStorage', {
  getItem: (key: string) => {
    if (key === 'mailflow_expanded_accounts') {
      return '{"malformed": }';
    }
    return null;
  },
  setItem: () => {},
  removeItem: () => {},
});

test('sidebar expandedAccounts state initialization falls back to an empty object when localStorage contains malformed JSON', async () => {
  const { useStore } = await import('./index.ts');
  assert.deepEqual(useStore.getState().expandedAccounts, {});
});
