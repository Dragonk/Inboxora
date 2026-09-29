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


describe('calendar preference hydration ownership', () => {
  beforeEach(() => {
    useStore.getState().setUser(null);
    useStore.getState().setUser({ id: 'calendar-owner' });
    api.savePreferences = async () => ({});
  });
  afterEach(() => {
    useStore.getState().setUser(null);
    api.getPreferences = originalGetPreferences;
    api.savePreferences = originalSavePreferences;
  });
  it('keeps a changed agenda and sender pair when an earlier GET resolves', async () => {
    const load = deferred();
    api.getPreferences = () => load.promise;
    const saves: unknown[] = [];
    api.savePreferences = async value => { saves.push(value); };
    const pending = useStore.getState().loadPreferences();
    useStore.getState().setCalendarShowAgenda(false);
    useStore.getState().setCalendarInviteSender('microsoft-account', 'second-alias');
    load.resolve({ calendarShowAgenda: true, calendarInviteAccountId: 'old-account', calendarInviteAliasId: 'old-alias', aiActions: [] });
    await pending;
    assert.equal(useStore.getState().calendarShowAgenda, false);
    assert.equal(useStore.getState().calendarInviteAccountId, 'microsoft-account');
    assert.equal(useStore.getState().calendarInviteAliasId, 'second-alias');
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.deepEqual(saves, [{ calendarShowAgenda: false, calendarInviteAccountId: 'microsoft-account', calendarInviteAliasId: 'second-alias' }]);
  });
  it('hydrates the untouched sender even when agenda changed during the GET', async () => {
    const load = deferred(); api.getPreferences = () => load.promise;
    const pending = useStore.getState().loadPreferences();
    useStore.getState().setCalendarShowAgenda(false);
    load.resolve({ calendarShowAgenda: true, calendarInviteAccountId: 'saved-account', calendarInviteAliasId: 'saved-alias', aiActions: [] });
    await pending;
    assert.equal(useStore.getState().calendarShowAgenda, false);
    assert.equal(useStore.getState().calendarInviteAccountId, 'saved-account');
    assert.equal(useStore.getState().calendarInviteAliasId, 'saved-alias');
  });
  it('hydrates the untouched agenda while preserving a cleared sender and alias', async () => {
    const load = deferred(); api.getPreferences = () => load.promise;
    const pending = useStore.getState().loadPreferences();
    useStore.getState().setCalendarInviteAccountId(null);
    load.resolve({ calendarShowAgenda: false, calendarInviteAccountId: 'old-account', calendarInviteAliasId: 'old-alias', aiActions: [] });
    await pending;
    assert.equal(useStore.getState().calendarShowAgenda, false);
    assert.equal(useStore.getState().calendarInviteAccountId, '');
    assert.equal(useStore.getState().calendarInviteAliasId, '');
  });
  it('hydrates saved values normally and never keeps an alias without its account', async () => {
    api.getPreferences = async () => ({ calendarShowAgenda: false, calendarInviteAccountId: 'saved-account', calendarInviteAliasId: 'saved-alias', aiActions: [] });
    await useStore.getState().loadPreferences();
    assert.equal(useStore.getState().calendarShowAgenda, false);
    assert.equal(useStore.getState().calendarInviteAliasId, 'saved-alias');
    api.getPreferences = async () => ({ calendarInviteAliasId: 'orphan-alias', aiActions: [] });
    await useStore.getState().loadPreferences();
    assert.equal(useStore.getState().calendarShowAgenda, true);
    assert.equal(useStore.getState().calendarInviteAccountId, '');
    assert.equal(useStore.getState().calendarInviteAliasId, '');
  });
});
