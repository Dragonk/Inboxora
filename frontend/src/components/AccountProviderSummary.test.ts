import assert from 'node:assert/strict';
import test from 'node:test';
import { providerServiceStatus } from './AccountProviderServices.tsx';

const t = (key: string, vars?: Record<string, unknown>) => vars?.code ? `${key}:${vars.code}` : key;
const connected = { enabled: true, authorized: true, synchronized: true };

test('provider summary prioritizes actionable state over previous success', () => {
  assert.equal(providerServiceStatus({ ...connected, enabled: false }, t), 'admin.plugins.disabledBadge');
  assert.equal(providerServiceStatus({ ...connected, authorized: false }, t), 'admin.accounts.services.notConnected');
  assert.equal(providerServiceStatus({ ...connected, syncErrorCode: 'API_DISABLED' }, t), 'admin.accounts.services.syncFailed:API_DISABLED');
  assert.equal(providerServiceStatus({ ...connected, syncPending: true }, t), 'admin.accounts.services.syncPending');
  assert.equal(providerServiceStatus(connected, t), 'admin.accounts.services.connected');
});

test('provider summary helper remains deterministic for missing status', () => {
  assert.equal(providerServiceStatus(null, t), 'admin.plugins.disabledBadge');
  assert.equal(providerServiceStatus({ enabled: true, authorized: true, synchronized: false }, t), 'admin.accounts.services.syncPending');
});
