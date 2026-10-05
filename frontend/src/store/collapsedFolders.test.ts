import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

describe('index store preferences', () => {
  const originalLocalStorage = globalThis.localStorage;

  after(() => {
    Reflect.set(globalThis, 'localStorage', originalLocalStorage);
  });

  it('collapsedFolders handles malformed JSON in localStorage', async () => {
    let localStorageValue: string | null = '{malformed';
    Reflect.set(globalThis, 'localStorage', {
      getItem: (key: string) => {
        if (key === 'mailflow_collapsed_folders') return localStorageValue;
        return null;
      },
      setItem: () => {},
      removeItem: () => {},
    });

    const { useStore } = await import('./index.ts?query=' + Date.now());
    assert.deepEqual(useStore.getState().collapsedFolders, []);
  });
});
