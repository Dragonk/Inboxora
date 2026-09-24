import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');

test('account settings expose provider-specific edit sections', () => {
  assert.match(source, /function SettingsSectionTabs/);
  assert.match(source, /editTarget\.mail_transport === 'microsoft_graph'/);
  assert.match(source, /id: 'general'/);
  assert.match(source, /id: 'services'/);
  assert.match(source, /id: 'servers'/);
  assert.match(source, /id: 'diagnostics'/);
  assert.match(source, /data-testid="account-editor-services"/);
  assert.match(source, /data-testid="account-editor-diagnostics"/);
});

test('calendar and contact settings use the mockup sub-tab structure', () => {
  assert.match(source, /calendar-settings-\$\{accountSection\}/);
  assert.match(source, /id: 'accounts', label: t\('admin\.tabs\.accounts'\)/);
  assert.match(source, /id: 'resources', label: t\('calendar\.calendars'\)/);
  assert.match(source, /data-testid="calendar-settings-import"/);
  assert.match(source, /view=\{accountSection as 'accounts' \| 'resources'\}/);
  assert.match(source, /function ContactsSettingsTab/);
  assert.match(source, /id: 'resources', label: t\('contacts\.addressBooks\.label'\)/);
  assert.match(source, /id: 'import', label: t\('contacts\.booksManager\.importExport'\)/);
  assert.match(source, /<ContactsPage settingsOnly settingsSection=\{section as 'accounts' \| 'resources' \| 'import'\}/);
});

test('integration provider and app views share the accessible sub-tab component', () => {
  assert.match(source, /label=\{t\('admin\.integrations\.title'\)\}/);
  assert.match(source, /id: 'emailProviders'/);
  assert.match(source, /id: 'apps'/);
  assert.match(source, /role="tablist"/);
  assert.match(source, /aria-selected=\{active === tab\.id\}/);
  assert.match(source, /'ArrowLeft', 'ArrowRight', 'Home', 'End'/);
});
