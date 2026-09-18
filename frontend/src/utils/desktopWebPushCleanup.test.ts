import test from 'node:test';
import assert from 'node:assert/strict';

import { createDesktopWebPushCleanup, type DesktopPushCleanupDeps } from './desktopWebPushCleanup.ts';

interface Harness {
  deps: DesktopPushCleanupDeps;
  calls: string[];
  unregistered: string[];
  unsubscribedLocally: string[];
  serverRemoved: string[];
  warnings: string[];
  setServerFailure(value: boolean): void;
}

function harness(registrations: Array<{ endpoint?: string; throwOnGet?: boolean }>, electron = true): Harness {
  const calls: string[] = [];
  const unregistered: string[] = [];
  const unsubscribedLocally: string[] = [];
  const serverRemoved: string[] = [];
  const warnings: string[] = [];
  let serverFailure = false;

  const container = {
    async getRegistrations() {
      calls.push('getRegistrations');
      return registrations.map((entry, index) => ({
        pushManager: entry.throwOnGet
          ? { getSubscription: async () => { throw new Error('no active worker'); } }
          : { getSubscription: async () => (entry.endpoint ? {
              endpoint: entry.endpoint,
              unsubscribe: async () => {
                unsubscribedLocally.push(entry.endpoint as string);
                calls.push(`localUnsubscribe:${entry.endpoint}`);
                return true;
              },
            } : null) },
        unregister: async () => { unregistered.push(`registration-${index}`); return true; },
      }));
    },
  };

  return {
    calls,
    unregistered,
    unsubscribedLocally,
    serverRemoved,
    warnings,
    setServerFailure(value) { serverFailure = value; },
    deps: {
      isElectronShell: () => electron,
      getServiceWorker: () => container,
      pushUnsubscribe: async ({ endpoint }) => {
        calls.push(`pushUnsubscribe:${endpoint}`);
        if (serverFailure) throw new Error('unauthorized');
        serverRemoved.push(endpoint);
      },
      warn: (message) => { warnings.push(message); },
    },
  };
}

test('an existing Web Push subscription is removed locally and on the server', async () => {
  const h = harness([{ endpoint: 'https://push.example/old' }]);
  const cleanup = createDesktopWebPushCleanup(h.deps);

  await cleanup.cleanup();

  assert.deepEqual(h.serverRemoved, ['https://push.example/old']);
  assert.deepEqual(h.unsubscribedLocally, ['https://push.example/old']);
  assert.deepEqual(h.unregistered, ['registration-0']);
  assert.deepEqual(cleanup.pendingServerUnsubscribes(), []);
  // Local first, then the server: unsubscribing is what stops the duplicate
  // immediately, and the server call may legitimately fail (no session yet) without
  // leaving the duplicate in place. The order is asserted so a reversal is caught.
  assert.deepEqual(h.calls, [
    'getRegistrations',
    'localUnsubscribe:https://push.example/old',
    'pushUnsubscribe:https://push.example/old',
  ]);
});

test('nothing happens outside the Electron shell, so browser Web Push is untouched', async () => {
  const h = harness([{ endpoint: 'https://push.example/browser' }], false);
  const cleanup = createDesktopWebPushCleanup(h.deps);

  await cleanup.cleanup();

  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.unregistered, []);
  assert.deepEqual(h.unsubscribedLocally, []);
});

test('a failing server unsubscribe still stops the duplicate and is retried later', async () => {
  const h = harness([{ endpoint: 'https://push.example/old' }]);
  const cleanup = createDesktopWebPushCleanup(h.deps);
  h.setServerFailure(true);

  await cleanup.cleanup();

  // The duplicate OS notification stops immediately...
  assert.deepEqual(h.unsubscribedLocally, ['https://push.example/old']);
  assert.deepEqual(h.unregistered, ['registration-0']);
  // ...while the endpoint waits for a call with a valid session.
  assert.deepEqual(cleanup.pendingServerUnsubscribes(), ['https://push.example/old']);
  assert.equal(h.warnings.length, 1);

  h.setServerFailure(false);
  await cleanup.cleanup();

  assert.deepEqual(h.serverRemoved, ['https://push.example/old']);
  assert.deepEqual(cleanup.pendingServerUnsubscribes(), []);
});

test('a registration without a subscription is still unregistered', async () => {
  const h = harness([{}, { throwOnGet: true }]);
  const cleanup = createDesktopWebPushCleanup(h.deps);

  await cleanup.cleanup();

  assert.deepEqual(h.unregistered, ['registration-0', 'registration-1']);
  assert.deepEqual(h.unsubscribedLocally, []);
  assert.deepEqual(cleanup.pendingServerUnsubscribes(), []);
});

test('a broken service worker container never throws out of the migration', async () => {
  const h = harness([]);
  h.deps.getServiceWorker = () => ({ getRegistrations: async () => { throw new Error('storage gone'); } });
  const cleanup = createDesktopWebPushCleanup(h.deps);

  await cleanup.cleanup();
  assert.deepEqual(cleanup.pendingServerUnsubscribes(), []);

  const noContainer = createDesktopWebPushCleanup({ ...h.deps, getServiceWorker: () => undefined });
  await noContainer.cleanup();
});
