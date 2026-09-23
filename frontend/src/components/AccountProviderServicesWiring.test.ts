import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const services = new URL('./AccountProviderServices.tsx', import.meta.url);
const api = new URL('../utils/api.ts', import.meta.url);
const app = new URL('../App.tsx', import.meta.url);

test('the account provider card reads one coherent status snapshot', async () => {
  const source = await readFile(services, 'utf8');
  const apiSource = await readFile(api, 'utf8');
  assert.match(apiSource, /accountProviderStatus: \(accountId: string\)/);
  assert.match(source, /api\.accountProviderStatus\(accountId\)/);
  assert.doesNotMatch(source, /api\.accountProviderDiagnostics\(accountId\)/);
  assert.match(source, /generation !== statusGeneration\.current/);
  assert.match(source, /setFeatures\(data\); setDiagnostics\(data\.diagnostics\)/);
});

test('service intent toggles persist per account and roll back on refusal', async () => {
  const source = await readFile(services, 'utf8');
  const apiSource = await readFile(api, 'utf8');
  assert.match(apiSource, /setAccountProviderFeature: \(accountId: string, feature: 'calendars' \| 'contacts', enabled: boolean\)/);
  assert.match(source, /data-testid={`account-feature-\$\{service\}`}/);
  assert.match(source, /setFeatures\(before\); setError\(/);
  assert.match(source, /feature\?\.enabled === false/);
  assert.match(source, /role="switch"/);
  assert.match(source, /aria-checked=\{checked\}/);
  assert.match(source, /feature\?\.enabled === false \? 'var\(--text-tertiary\)'/);
});

test('Google Contacts API-disabled guidance links configuration and retries this account service', async () => {
  const source = await readFile(services, 'utf8');
  assert.match(source, /google-contacts-api-disabled/);
  assert.match(source, /PROVIDER_API_DISABLED/);
  assert.match(source, /admin\.integrations\.google\.step2/);
  assert.match(source, /href="\/settings\?section=integrations"/);
  assert.match(source, /google-contacts-check-again/);
  assert.match(source, /api\.syncAccountProviderFeature\(accountId, feature\)/);
  assert.match(source, /retryFeatureSync\('contacts'\)/);
});

test('OAuth errors are never assigned to another account card', async () => {
  const source = await readFile(services, 'utf8');
  const appSource = await readFile(app, 'utf8');
  assert.match(source, /data\.type === 'oauth_error'/);
  assert.match(source, /typeof data\.accountId !== 'string' \|\| data\.accountId !== accountId/);
  assert.match(appSource, /type: 'oauth_error', error: oauthError, accountId: params\.get\('accountId'\)/);
});
