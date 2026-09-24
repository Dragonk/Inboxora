import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const read = (name: string) => readFile(new URL(`./${name}`, import.meta.url), 'utf8');

test('calendar events expose keyboard and pointer context-menu actions', async () => {
  const source = await read('CalendarPage.tsx');
  assert.match(source, /onContextMenu=/);
  assert.match(source, /CalendarContextMenu/);
  assert.match(source, /keyboardEvent\.key/);
  assert.doesNotMatch(source, /data-testid="calendar-event-actions"/);
});

test('calendar management uses the sidebar navigation and settings manager', async () => {
  const [sidebar, manager] = await Promise.all([read('CalendarSidebar.tsx'), read('CalendarSettingsManager.tsx')]);
  assert.match(sidebar, /calendar-sidebar-manage-sources/);
  assert.match(sidebar, /openSettings/);
  assert.match(manager, /ServiceSettingsView/);
  assert.match(manager, /view\?: 'accounts' \| 'resources' \| 'import'/);
  assert.match(manager, /api\.calendar\.presentation\(\)/);
});

test('calendar settings expose recurrence and import controls', async () => {
  const source = await read('CalendarPage.tsx');
  const manager = await read('CalendarSettingsManager.tsx');
  assert.match(source, /calendar-recurrence/);
  assert.match(source, /CalendarDeleteScopeDialog/);
  assert.match(manager, /api\.calendar\.importIcs/);
  assert.match(manager, /accept="\.ics,text\/calendar"/);
});

test('all locales contain one calendar dictionary', async () => {
  const dir = new URL('../locales/', import.meta.url);
  for (const name of (await readdir(dir)).filter(name => name.endsWith('.json'))) {
    const source = await readFile(new URL(name, dir), 'utf8');
    assert.equal(source.match(/^ {2}"calendar"\s*:/gm)?.length, 1, name);
  }
});
