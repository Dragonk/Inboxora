import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return {
        format: 'module',
        source: `export default ${readFileSync(new URL(url), 'utf8')}`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

Reflect.set(globalThis, 'localStorage', (() => {
  let values: Record<string, string> = { mailflow_theme: 'dark' };
  return {
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: unknown) => { values[key] = String(value); },
    removeItem: (key: string) => { delete values[key]; },
    clear: () => { values = {}; },
  };
})());

const { api } = await import('../utils/api.ts');
const { useStore } = await import('./index.ts');
const originalGetPreferences = api.getPreferences;
const originalSavePreferences = api.savePreferences;

function deferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (reason?: unknown) => void } {
  let resolve: (value: unknown) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Undo Send preference safety', () => {
  beforeEach(() => {
    useStore.getState().setUser(null);
    useStore.getState().setUser({ id: 'undo-user' });
  });
  afterEach(() => {
    api.getPreferences = originalGetPreferences;
    api.savePreferences = originalSavePreferences;
  });

  it('starts blocked, loads the server value, and defaults a missing value to zero', async () => {
    assert.equal(useStore.getState().undoSendPreferencesStatus, 'loading');
    api.getPreferences = async () => ({ undoSendSeconds: 60, aiActions: [] });
    await useStore.getState().loadPreferences();
    assert.equal(useStore.getState().undoSendSeconds, 60);
    assert.equal(useStore.getState().undoSendPreferencesStatus, 'ready');
    api.getPreferences = async () => ({ aiActions: [] });
    await useStore.getState().loadPreferences();
    assert.equal(useStore.getState().undoSendSeconds, 0);
  });

  it('keeps sending blocked after unavailable or malformed server preferences', async () => {
    api.getPreferences = async () => { throw new Error('offline'); };
    await useStore.getState().loadPreferences();
    assert.equal(useStore.getState().undoSendPreferencesStatus, 'error');
    for (const value of [-1, 61, 0.5, '20']) {
      api.getPreferences = async () => ({ undoSendSeconds: value, aiActions: [] });
      await useStore.getState().loadPreferences();
      assert.equal(useStore.getState().undoSendPreferencesStatus, 'error');
    }
  });

  it('persists whole seconds and surfaces failures without optimistic preference changes', async () => {
    const saves: Record<string, unknown>[] = [];
    api.savePreferences = async value => { saves.push(value); };
    await useStore.getState().setUndoSendSeconds(35);
    assert.deepEqual(saves, [{ undoSendSeconds: 35 }]);
    assert.equal(useStore.getState().undoSendSeconds, 35);
    for (const invalid of [-1, 61, 2.5, NaN]) await assert.rejects(useStore.getState().setUndoSendSeconds(invalid), RangeError);
    assert.equal(saves.length, 1);
    api.savePreferences = async () => { throw new Error('offline'); };
    await assert.rejects(useStore.getState().setUndoSendSeconds(0), /offline/);
    assert.equal(useStore.getState().undoSendSeconds, 35);
    assert.equal(useStore.getState().undoSendPreferencesStatus, 'error');
    assert.equal(useStore.getState().undoSendSecondsSaving, false);
  });

  it('does not hydrate an old session even when the same user signs in again', async () => {
    const load = deferred();
    api.getPreferences = () => load.promise;
    const pending = useStore.getState().loadPreferences();
    useStore.getState().setUser(null);
    useStore.getState().setUser({ id: 'undo-user' });
    load.resolve({ undoSendSeconds: 60, aiActions: [] });
    await pending;
    assert.equal(useStore.getState().undoSendSeconds, 0);
    assert.equal(useStore.getState().undoSendPreferencesStatus, 'loading');
  });

  it('does not apply an old save after same-user reauthentication', async () => {
    const save = deferred();
    api.savePreferences = () => save.promise;
    const pending = useStore.getState().setUndoSendSeconds(30);
    useStore.getState().setUser(null);
    useStore.getState().setUser({ id: 'undo-user' });
    save.resolve({});
    await pending;
    assert.equal(useStore.getState().undoSendSeconds, 0);
    assert.equal(useStore.getState().undoSendPreferencesStatus, 'loading');
    assert.equal(useStore.getState().undoSendSecondsSaving, false);
  });

  it('does not overwrite a successful save with an older preference fetch', async () => {
    const load = deferred();
    api.getPreferences = () => load.promise;
    api.savePreferences = async () => ({});
    const pending = useStore.getState().loadPreferences();
    await useStore.getState().setUndoSendSeconds(45);
    load.resolve({ undoSendSeconds: 0, aiActions: [] });
    await pending;
    assert.equal(useStore.getState().undoSendSeconds, 45);
    assert.equal(useStore.getState().undoSendPreferencesStatus, 'ready');
  });
});
