import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('recentFolders store initialization', () => {
  it('returns empty array when localStorage contains malformed JSON', async () => {
    // Setup memory storage mimicking the behaviour of the folderOrder.test.ts
    const originalLocalStorage = Reflect.get(globalThis, 'localStorage');

    try {
      Reflect.set(globalThis, 'localStorage', {
        getItem: (key: string) => {
          if (key === 'mailflow_recent_folders') {
            return '{ malformed: "json"';
          }
          return null;
        },
        setItem() {},
        removeItem() {},
      });

      const { useStore } = await import(`./index.ts?bust=${Date.now()}`);
      const state = useStore.getState();

      assert.deepEqual(state.recentFolders, []);
    } finally {
      if(originalLocalStorage) {
         Reflect.set(globalThis, 'localStorage', originalLocalStorage);
      } else {
         Reflect.deleteProperty(globalThis, 'localStorage');
      }
    }
  });
});
