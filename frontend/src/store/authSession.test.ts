import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
  return nextLoad(url, context);
} });

const storage = new Map<string, string>();
Reflect.set(globalThis, 'localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, String(value)); },
  removeItem: (key: string) => { storage.delete(key); },
});

const { useStore } = await import('./index.ts');

function reset() {
  storage.clear();
  useStore.setState({ user: null, authEpoch: 0, selectedAccountId: null, selectedFolder: 'INBOX' });
}

test('owned navigation survives the same user bootstrap', () => {
  reset();
  storage.set('mailflow_selected_account', 'account-a');
  storage.set('mailflow_selected_folder', 'Archive');
  storage.set('mailflow_selected_navigation_owner', 'user-a');
  useStore.setState({ selectedAccountId: 'account-a', selectedFolder: 'Archive' });

  useStore.getState().setUser({ id: 'user-a' });

  assert.equal(useStore.getState().selectedAccountId, 'account-a');
  assert.equal(useStore.getState().selectedFolder, 'Archive');
  assert.equal(useStore.getState().authEpoch, 1);
});

test('a bootstrap never restores navigation owned by another user', () => {
  reset();
  storage.set('mailflow_selected_account', 'account-a');
  storage.set('mailflow_selected_folder', 'Archive');
  storage.set('mailflow_selected_navigation_owner', 'user-a');
  useStore.setState({ selectedAccountId: 'account-a', selectedFolder: 'Archive' });

  useStore.getState().setUser({ id: 'user-b' });

  assert.equal(useStore.getState().selectedAccountId, null);
  assert.equal(useStore.getState().selectedFolder, 'INBOX');
  assert.equal(storage.has('mailflow_selected_account'), false);
  assert.equal(storage.has('mailflow_selected_navigation_owner'), false);
});

test('identity changes advance the generation used to discard late callbacks', () => {
  reset();
  useStore.getState().setUser({ id: 'user-a' });
  const afterA = useStore.getState().authEpoch;
  useStore.getState().setUser(null);
  const afterLogout = useStore.getState().authEpoch;
  useStore.getState().setUser({ id: 'user-b' });

  assert.equal(afterLogout, afterA + 1);
  assert.equal(useStore.getState().authEpoch, afterLogout + 1);
});
