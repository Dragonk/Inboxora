import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('favoriteFolders store initialization', () => {
  it('returns empty array when localStorage contains malformed JSON', async () => {
    const originalLocalStorage = Reflect.get(globalThis, 'localStorage');

    try {
      Reflect.set(globalThis, 'localStorage', {
        getItem: (key: string) => {
          if (key === 'mailflow_favorite_folders') {
            return '{ malformed: "json"';
          }
          return null;
        },
        setItem() {},
        removeItem() {},
      });

      const { useStore } = await import(`./index.ts?bust=${Date.now()}`);
      const state = useStore.getState();

      assert.deepEqual(state.favoriteFolders, []);
    } finally {
      if(originalLocalStorage) {
         Reflect.set(globalThis, 'localStorage', originalLocalStorage);
      } else {
         Reflect.deleteProperty(globalThis, 'localStorage');
      }
    }
  });
});
