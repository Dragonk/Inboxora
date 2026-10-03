import assert from 'node:assert/strict';
import { afterEach, before, test } from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { newMcpGrant, emptyResources, MCP_SCOPES, type McpGrantInput } from '../../utils/mcp.ts';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
// Node tests render behavior; Playwright validates the actual styles.
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/hooks/useBackNavigation.ts')) return { format: 'module', source: 'export function useBackLayer() {} export function useBackNavigation() {}', shortCircuit: true };
  if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true };
  return nextLoad(url, context);
} });
const storage = new Map<string, string>();
Reflect.set(globalThis, 'localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
});
const { default: McpGrantForm } = await import('./McpGrantForm.tsx');

let renderer: ReactTestRenderer | undefined;
before(async () => { await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: {} } } }); });
afterEach(() => { if (renderer) act(() => renderer?.unmount()); renderer = undefined; });
function render(allowedScopes = MCP_SCOPES as readonly typeof MCP_SCOPES[number][]) {
  let changed: McpGrantInput | undefined;
  act(() => { renderer = create(React.createElement(McpGrantForm, {
    value: newMcpGrant('Test client'), resources: emptyResources, allowedScopes,
    onChange: value => { changed = value; },
  })); });
  if (!renderer) throw new Error('Expected a rendered grant form');
  return { root: renderer.root, value: () => changed };
}

test('MCP form requires explicit send permission and keeps confirmation enabled', () => {
  const form = render();
  const boxes = form.root.findAllByType('input').filter(input => input.props.type === 'checkbox');
  const send = boxes[MCP_SCOPES.indexOf('mail.send')];
  assert.equal(send.props.checked, false);
  act(() => send.props.onChange({ target: { checked: true } }));
  assert.equal(form.value()?.scopes.includes('mail.send'), true);
  assert.equal(form.value()?.requireConfirmation, true);
});

test('MCP form treats an empty folder selection as no access', () => {
  const form = render();
  const fieldset = form.root.findAllByType('fieldset').find(field => field.findByType('legend').children.includes('mcp.folders'));
  assert.ok(fieldset);
  const allFolders = fieldset.findByType('input');
  assert.equal(allFolders.props.checked, true);
  act(() => allFolders.props.onChange({ target: { checked: false } }));
  assert.deepEqual(form.value()?.restrictions.folders, []);
});

test('MCP OAuth consent offers only the permissions requested by the client', () => {
  const form = render(['mail.read']);
  const scopeFieldset = form.root.findAllByType('fieldset')[0];
  assert.equal(scopeFieldset.findAllByType('input').length, 1);
  assert.equal(scopeFieldset.findAllByType('small')[0].children[0], 'mail.read');
});
