import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('calendar preferences have their own tab and mobile navigation is global', async () => {
  const [adminPanel, calendar] = await Promise.all([
    source('./AdminPanel.tsx'),
    source('./CalendarPage.tsx'),
  ]);

  assert.match(adminPanel, /testId="calendar-week-start-setting"/);
  assert.match(adminPanel, /testId="mobile-navigation-position-setting"/);
  assert.match(adminPanel, /adminTab === 'calendar' && <CalendarSettingsTab/);
  assert.match(adminPanel, /setCalendarWeekStartsOn/);
  assert.match(adminPanel, /setMobileNavigationPosition/);
  assert.doesNotMatch(calendar, /onWeekStartsOnChange/);
  assert.doesNotMatch(calendar, /onMobileNavigationPositionChange/);
});

test('the invitation sender lives in Calendars and includes API mailboxes and their aliases', async () => {
  const [settings, section, calendar, senders] = await Promise.all([
    source('./accountUi/CalendarSenderSettings.tsx'), source('./accountUi/SettingsSections.tsx'),
    source('./CalendarPage.tsx'), source('../utils/calendarSenders.ts'),
  ]);
  assert.match(section, /section === 'resources' && <CalendarSenderSettings/);
  assert.match(settings, /data-testid="calendar-invite-account-setting"/);
  assert.match(settings, /setCalendarInviteSender/);
  assert.match(settings, /calendar\.defaultInviteAccountDescription/);
  assert.match(senders, /microsoft_graph/); assert.match(senders, /gmail_api/); assert.match(senders, /account.aliases/);
  assert.match(calendar, /calendarInviteAliasId = useStore/);
  assert.match(calendar, /calendarSenders\(senderAccounts\)\.find/);
  assert.match(calendar, /defaultSender\?\.aliasId/);
});

test('external calendar management is directly discoverable from the calendar visibility panel', async () => {
  const [calendar, sidebar] = await Promise.all([
    source('./CalendarPage.tsx'),
    source('./CalendarSidebar.tsx'),
  ]);

  assert.doesNotMatch(calendar, /data-testid="calendar-manage-sources"/);
  assert.match(sidebar, /data-testid="calendar-sidebar-manage-sources"/);
  assert.match(sidebar, /sourcePanelRequest/);
});