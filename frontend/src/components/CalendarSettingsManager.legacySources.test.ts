import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name: string) =>
  readFile(new URL(`./${name}`, import.meta.url), 'utf8');

test('calendar settings exposes local cleanup for orphaned CalDAV and ICS sources', async () => {
  const source = await read('CalendarSettingsManager.tsx');

  assert.match(source, /connection\.id\.startsWith\('collection:'\)/);
  assert.match(source, /connection\.kind === 'caldav'/);
  assert.match(source, /connection\.kind === 'ical_url'/);
  assert.match(source, /api\.calendar\.forgetLegacySource/);
  assert.match(source, /setForgetting\(connection\)/);
});

test('current calendar sources continue using the normal disconnect path', async () => {
  const source = await read('CalendarSettingsManager.tsx');

  assert.match(source, /api\.calendar\.deleteSource\(disconnecting\.id\)/);
  assert.match(source, /setDisconnecting\(external\)/);
});
