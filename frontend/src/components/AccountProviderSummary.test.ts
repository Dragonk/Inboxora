import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { providerServiceStatus } from './AccountProviderServices.tsx';

const t = (key: string, vars?: Record<string, unknown>) => vars?.code ? `${key}:${vars.code}` : key;
const connected = { enabled: true, authorized: true, synchronized: true };

test('provider summary prioritizes disabled intent, authorization, failure and pending over past success', () => {
  assert.equal(providerServiceStatus({ ...connected, enabled: false, syncErrorCode: 'OLD' }, t), 'admin.plugins.disabledBadge');
  assert.equal(providerServiceStatus(null, t), 'admin.plugins.disabledBadge');
  assert.equal(providerServiceStatus({ ...connected, authorized: false }, t), 'admin.accounts.services.notConnected');
  assert.equal(providerServiceStatus({ ...connected, syncErrorCode: 'API_DISABLED' }, t), 'admin.accounts.services.syncFailed:API_DISABLED');
  assert.equal(providerServiceStatus({ ...connected, syncPending: true }, t), 'admin.accounts.services.syncPending');
  assert.equal(providerServiceStatus({ ...connected, synchronized: false }, t), 'admin.accounts.services.syncPending');
  assert.equal(providerServiceStatus(connected, t), 'admin.accounts.services.connected');
});

test('overview is read-only and staged edits survive refresh without writing before Save', async () => {
  const source = await readFile(new URL('./AccountProviderServices.tsx', import.meta.url), 'utf8');
  const panel = await readFile(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
  const compact = source.slice(source.indexOf('if (compact)'), source.indexOf('const provider = features.provider'));
  assert.match(compact, /account-provider-summary/);
  assert.doesNotMatch(compact, /onClick|role="switch"/);
  assert.match(panel, /accountId=\{account.id\} reload=\{loadAccounts\} t=\{t\} compact/);
  const staging = source.slice(source.indexOf('if (deferServiceChanges)'), source.indexOf('setFeatureSaving(service)'));
  assert.match(staging, /stagedIntent.current\[service\] = enabled/);
  assert.match(staging, /onFeatureIntentChange\?\.\(service, enabled\)/);
  assert.match(staging, /return;/);
  assert.doesNotMatch(staging, /api\./);
  assert.match(source, /const enabled = stagedIntent.current\[service\]/);
  assert.match(source, /return \(\) => \{ statusGeneration.current \+= 1; \}/);
});
