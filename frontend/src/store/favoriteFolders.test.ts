import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

describe('favoriteFolders', () => {
  const originalLocalStorage = globalThis.localStorage;

  after(() => {
    Reflect.set(globalThis, 'localStorage', originalLocalStorage);
  });

  it('returns an empty array when localStorage contains malformed JSON', async () => {
    Reflect.set(globalThis, 'localStorage', (() => {
      let values: Record<string, string> = {
        mailflow_favorite_folders: '{ malformed: '
      };
      return {
        getItem: (key: string) => values[key] ?? null,
        setItem: (key: string, value: unknown) => { values[key] = String(value); },
        removeItem: (key: string) => { delete values[key]; },
        clear: () => { values = {}; },
      };
    })());

    // Import the store dynamically to ensure it uses the mocked localStorage during initialization
    const { useStore } = await import('./index.ts?bust=' + Date.now()) as typeof import('./index.ts');
    const favoriteFolders = useStore.getState().favoriteFolders;
    assert.deepEqual(favoriteFolders, []);
  });
});
