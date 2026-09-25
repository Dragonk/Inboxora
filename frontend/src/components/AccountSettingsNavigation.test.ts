import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name: string) => readFile(new URL(`./${name}`, import.meta.url), 'utf8');

test('account editor exposes shared settings navigation and provider service sections', async () => {
  const source = await read('accountUi/SettingsSections.tsx');
  const editor = await read('accountUi/MailAccountEditor.tsx');
  assert.match(source, /role="tablist"/);
  assert.match(source, /aria-selected=\{active === tab\.id\}/);
  for (const id of ['accounts', 'resources', 'import']) assert.match(source, new RegExp(`id: '${id}'`));
  assert.match(editor, /section === 'services'/);
  assert.match(editor, /section === 'servers'/);
});

test('calendar and contact settings share account/resource/import section grammar', async () => {
  const source = await read('accountUi/SettingsSections.tsx');
  assert.match(source, /export function CalendarAccountsSettings/);
  assert.match(source, /export function ContactAccountsSettings/);
  assert.match(source, /CalendarSettingsManager[^\n]+view=\{section\}/);
  assert.match(source, /ContactsPage key=\{epoch\} settingsOnly settingsSection=\{section\}/);
});
