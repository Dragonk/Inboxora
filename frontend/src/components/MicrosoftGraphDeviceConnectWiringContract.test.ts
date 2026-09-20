import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The Microsoft device-code authorization is a method for **one account**, so it lives on the Add-account
 * screen (and the account's card), never as a primary action in Integrations. Integrations keeps the
 * configuration toggle and its readiness; these cases pin both halves.
 */

const panel = new URL('./AdminPanel.tsx', import.meta.url);
const flow = new URL('./AddAccountFlow.tsx', import.meta.url);

test('Integrations configures the device method without starting it', async () => {
  const source = await readFile(panel, 'utf8');
  const integrations = source.slice(source.indexOf('function IntegrationsTab'), source.indexOf('function SSOTab'));
  // No device-code action, and no handler that could start one, on the installation's page.
  assert.ok(!integrations.includes('microsoft-graph-device-connect'));
  assert.ok(!integrations.includes('handleStartGraphDeviceFlow'));
  assert.ok(!integrations.includes('startProviderMsDeviceFlow'));
  // The configuration and its readiness stay.
  assert.match(integrations, /admin\.integrations\.microsoft\.save/);
  assert.match(integrations, /deviceCode/);
});

test('the account flow offers the device code as the alternate method', async () => {
  const source = await readFile(flow, 'utf8');
  assert.match(source, /data-testid="add-account-microsoft-device"/);
  assert.match(source, /startProviderMsDeviceFlow\('mail_migration'\)/);
  assert.match(source, /data-testid="add-account-microsoft-device-code"/);
  // Browser sign-in stays the primary action when it is configured.
  assert.match(source, /data-testid="add-account-microsoft-browser"/);
});
