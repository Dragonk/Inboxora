import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, mock } from 'node:test';
import { api } from './api.ts';
import { getAuthEpoch, setAuthEpoch } from './authEpoch.ts';
import { clearMcpReturn, mcpRequest, newMcpGrant, pendingMcpReturn, rememberMcpReturn, safeMcpReturn } from './mcp.ts';

const storage = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
beforeEach(() => {
  storage.clear();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  } });
});
afterEach(() => {
  mock.restoreAll();
  if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'sessionStorage');
});

test('MCP defaults to read-only scopes and human confirmation', () => {
  const grant = newMcpGrant('Test client');
  assert.deepEqual(grant.scopes, ['mail.read', 'calendar.read', 'contacts.read']);
  assert.equal(grant.requireConfirmation, true);
  assert.equal(grant.expiresInDays, 90);
});

test('MCP login restores only exact internal consent paths', () => {
  const path = `/ai/mcp/authorize?request=${'a'.repeat(43)}`;
  assert.equal(safeMcpReturn(path), path);
  for (const value of ['https://attacker.example', '//attacker.example', path + '&redirect=https://attacker.example', '/api/mcp/tokens', null]) {
    assert.equal(safeMcpReturn(value), null);
  }
  rememberMcpReturn(path);
  assert.equal(pendingMcpReturn(), path);
  clearMcpReturn();
  assert.equal(pendingMcpReturn(), null);
  rememberMcpReturn(path);
  mock.method(Date, 'now', () => Number.MAX_SAFE_INTEGER);
  assert.equal(pendingMcpReturn(), null);
});

test('MCP never exposes a token returned after the identity changes', async () => {
  let settle!: (value: unknown) => void;
  mock.method(api.mcp, 'request', () => new Promise<unknown>(resolve => { settle = resolve; }));
  const request = mcpRequest('POST', '/tokens', { name: 'Test client' });
  const refusal = assert.rejects(request, /Session changed/);
  setAuthEpoch(getAuthEpoch() + 1);
  settle({ token: 'synthetic-secret' });
  await refusal;
});
