import { test, after } from 'node:test';
import assert from 'node:assert/strict';

test('sidebar expandedAccounts state initialization falls back to an empty object when localStorage contains malformed JSON', async () => {
  const originalLocalStorage = Reflect.get(globalThis, 'localStorage');

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

  after(() => {
    Reflect.set(globalThis, 'localStorage', originalLocalStorage);
  });

  const { useStore } = await import(`./index.ts?bust=${Date.now()}`);
  assert.deepEqual(useStore.getState().expandedAccounts, {});
});
