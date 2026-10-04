import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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

const { useStore } = await import('./index.ts');

describe('favoriteFolders initialization', () => {
  it('returns an empty array when localStorage contains malformed JSON', () => {
    const favoriteFolders = useStore.getState().favoriteFolders;
    assert.deepEqual(favoriteFolders, []);
  });
});
