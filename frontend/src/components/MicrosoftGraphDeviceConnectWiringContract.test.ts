import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The Graph connector used to be reachable only through the browser flow, which needs a client secret
 * and a registered callback. These assertions pin the device-code path that makes it reachable for a
 * public client: the same provider connection, authorized without either.
 */

const adminPanelPath = new URL('./AdminPanel.tsx', import.meta.url);
const apiPath = new URL('../utils/api.ts', import.meta.url);

test('the Graph connector section stays visible when only the device method is ready', async () => {
  const source = await readFile(adminPanelPath, 'utf8');
  // The section must not be hidden behind the browser flow's readiness, or a public-client
  // installation never sees the device action at all.
  assert.match(source, /\{\(msStatus\?\.graph\?\.ready \|\| msDeviceReady\) && \(/);
  // The browser action keeps its own gate: a device-ready installation without a callback must not
  // be offered a redirect flow.
  assert.match(source, /\{msStatus\?\.graph\?\.ready && \(\s*<button\s*data-testid="microsoft-graph-connect"/);
});

test('the card starts the provider device flow and polls it to completion', async () => {
  const source = await readFile(adminPanelPath, 'utf8');
  const start = source.indexOf('const handleStartGraphDeviceFlow');
  assert.notEqual(start, -1, 'the Graph device handler is missing');
  const handler = source.slice(start, source.indexOf('const handleConnectMs', start));
  assert.match(handler, /api\.startProviderMsDeviceFlow\(\)/);
  assert.match(handler, /api\.pollProviderMsDeviceFlow\(String\(data\.flowId\)\)/);
  // A device flow is not an account sign-in: it refreshes the connector status, not the mailbox list.
  assert.match(handler, /api\.getIntegrationsStatus\(\)/);
  assert.doesNotMatch(handler, /api\.getAccounts\(\)/);
  assert.match(source, /data-testid="microsoft-graph-device-connect"/);
});

test('the API client targets the provider device endpoints, not the mailbox ones', async () => {
  const source = await readFile(apiPath, 'utf8');
  const start = source.indexOf('startProviderMsDeviceFlow');
  assert.notEqual(start, -1, 'the provider device start helper is missing');
  const region = source.slice(start, source.indexOf('// Sync', start));
  assert.match(region, /'\/oauth\/provider\/microsoft\/device'/);
  assert.match(region, /'\/oauth\/provider\/microsoft\/device\/poll'/);
  // The mailbox device flow's endpoints must not be reused: they yield IMAP/SMTP tokens.
  assert.doesNotMatch(region, /'\/oauth\/microsoft\/device'/);
  assert.match(region, /JSON\.stringify\(\{ flowId \}\)/);
});
