import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name: string) => readFile(new URL(`./${name}`, import.meta.url), 'utf8');

test('calendar subscription settings cover URL, local, DAV and holiday sources', async () => {
  const source = await read('CalendarSubscriptionsSettings.tsx');
  assert.match(source, /data-testid="calendar-subscriptions-settings"/);
  assert.match(source, /api\.calendar\.createSource\(\{ kind: 'ical_url'/);
  assert.match(source, /data-testid="calendar-local-create-form"/);
  assert.match(source, /data-testid="calendar-caldav-settings-form"/);
  assert.match(source, /holidayCalendarUrl\(entry\.file\)/);
  assert.match(source, /normalizeSubscriptionUrl/);
});

test('subscription rows expose pause, resume and deletion actions', async () => {
  const source = await read('CalendarSubscriptionsSettings.tsx');
  assert.match(source, /data-testid="calendar-subscription-row"/);
  assert.match(source, /api\.calendar\.updateSource\(id, \{ enabled \}\)/);
  assert.match(source, /api\.calendar\.deleteSource/);
  assert.match(source, /inboxora:calendar-changed/);
});
