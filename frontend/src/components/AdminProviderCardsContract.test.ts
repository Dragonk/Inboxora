import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const adminPanelPath = new URL('./AdminPanel.tsx', import.meta.url);

async function googleCardSource(): Promise<string> {
  const source = await readFile(adminPanelPath, 'utf8');
  const start = source.indexOf('{/* Google — same card layout as Microsoft, different methods. */}');
  assert.notEqual(start, -1, 'the Google provider card is missing');
  const end = source.indexOf("{subTab === 'apps'", start);
  assert.notEqual(end, -1, 'could not bound the Google provider card');
  return source.slice(start, end);
}

test('the Google provider card lives in the existing email-providers subtab', async () => {
  const source = await readFile(adminPanelPath, 'utf8');
  const emailProviders = source.indexOf("{subTab === 'emailProviders'");
  const google = source.indexOf('{/* Google — same card layout as Microsoft, different methods. */}');
  const apps = source.indexOf("{subTab === 'apps'");
  assert.ok(emailProviders !== -1 && google !== -1 && apps !== -1);
  // Google sits after Microsoft inside emailProviders and before the apps subtab,
  // so it extends the existing screen instead of creating a second configuration.
  assert.ok(emailProviders < google && google < apps);
});

test('the Google card describes its own policy above the fields', async () => {
  const card = await googleCardSource();
  const description = card.indexOf("t('admin.integrations.google.description')");
  const clientId = card.indexOf("t('admin.integrations.microsoft.clientId')");
  assert.ok(description !== -1 && clientId !== -1);
  assert.ok(description < clientId, 'the setup description must appear above the fields');
  assert.match(card, /t\('admin\.integrations\.google\.setupTitle'\)/);
  assert.match(card, /t\('admin\.integrations\.google\.step4'\)/);
});

test('the Google card never offers a device-code flow and keeps app-password mail', async () => {
  const card = await googleCardSource();
  // MUST NOT: no Google device code for Gmail/Calendar/People.
  assert.doesNotMatch(card, /deviceCodeStart|startGoogleDeviceFlow|pollGoogleDeviceFlow|deviceFlow/);
  assert.match(card, /t\('admin\.integrations\.google\.deviceNotSupported'\)/);
  // MUST: state that IMAP/SMTP with an app password does not depend on this config.
  assert.match(card, /t\('admin\.integrations\.google\.appPasswordNote'\)/);
  // The Google callback path used by the instruction and the placeholder.
  assert.match(card, /oauth\/google\/callback/);
});

test('the Google card is admin-configurable but non-admins only see readiness', async () => {
  const card = await googleCardSource();
  assert.match(card, /isAdmin && \(<>/);
  assert.match(card, /!isAdmin && \(/);
  assert.match(card, /t\('admin\.integrations\.google\.userNoteNotConfigured'\)/);
  // Readiness comes from the backend, not from the presence of a saved Client ID alone.
  assert.match(card, /googleWebReady/);
});
