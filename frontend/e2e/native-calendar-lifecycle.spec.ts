import { test, expect } from './fixtures.ts';

async function openGoogleCalendarSettings(page: import('@playwright/test').Page, management = true) {
  await page.route('**/api/calendar/sources', route => route.fulfill({ json: { sources: [] } }));
  await page.route('**/api/calendar/calendars', route => route.fulfill({ json: { calendars: [{ id: 'native-calendar', name: 'Remote calendar', source: 'google', read_only: false, collection_id: 'collection-1' }] } }));
  await page.route('**/api/calendar/presentation', route => route.fulfill({ json: { sources: [{ id: 'google-source', kind: 'google', label: 'Google', accountId: 'account-1', identityLabel: 'same@example.test', featureEnabled: true, canSync: true, collapsed: false }], groups: [{ id: 'google-source', kind: 'google', label: 'Google', accountId: 'account-1', identityLabel: 'same@example.test', featureEnabled: true, canSync: true, collapsed: false, calendars: [{ id: 'native-calendar', sourceId: 'google-source', displayName: 'Remote calendar', readOnly: false, selected: true, sidebarHidden: false }] }] } }));
  await page.route('**/api/accounts/account-1/provider-features', route => route.fulfill({ json: { calendar: { calendarManagement: { authorized: management, requiredScopes: ['calendar.calendars'], missingScopes: management ? [] : ['calendar.calendars'] } } } }));
  await page.goto('/');
  const mobile = page.viewportSize()!.width < 768;
  if (mobile) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if (mobile) await page.getByTestId('mobile-settings').click();
  else await page.getByText(/^Ustawienia$|^Settings$/i).first().click();
  if (mobile) await page.getByRole('button', { name: /^Kalendarz · Konta$|^Calendar · Accounts$/ }).click();
  else await page.getByRole('button', { name: /^Konta$|^Accounts$/ }).nth(1).click();
  await page.getByTestId('calendar-manager-source').filter({ hasText: 'Google' }).click();
}

test('native lifecycle uses exact selected account endpoints and never fakes local deletion', async ({ page, fixtureApi }) => {
  await fixtureApi;
  await openGoogleCalendarSettings(page);
  const writes: Array<{ method: string; url: string; body: unknown }> = [];
  await page.route('**/api/accounts/account-1/provider-calendars**', async route => {
    writes.push({ method: route.request().method(), url: route.request().url(), body: route.request().postDataJSON() });
    await route.fulfill({ json: { state: 'confirmed', operationId: 'op-1', collectionId: 'collection-1', localCalendarId: 'native-calendar' } });
  });
  await page.getByTestId('calendar-native-name').fill('New remote');
  await page.getByTestId('calendar-native-create-submit').click();
  await expect(page.getByTestId('calendar-native-operation-status')).toBeVisible();
  await page.getByTestId('calendar-native-delete').click();
  await expect(page.getByTestId('calendar-native-delete-dialog')).toBeVisible();
  await page.getByTestId('calendar-native-delete-confirm').click();
  expect(writes).toEqual([
    { method: 'POST', url: expect.stringMatching(/\/api\/accounts\/account-1\/provider-calendars$/), body: expect.objectContaining({ name: 'New remote', idempotencyKey: expect.any(String) }) },
    { method: 'DELETE', url: expect.stringMatching(/\/api\/accounts\/account-1\/provider-calendars\/collection-1$/), body: expect.objectContaining({ idempotencyKey: expect.any(String) }) },
  ]);
  await expect(page.getByTestId('calendar-manager-calendar')).toContainText('Remote calendar');
});

test('missing lifecycle scope provides Google reconsent and does not offer native buttons', async ({ page, fixtureApi }) => {
  await fixtureApi;
  await openGoogleCalendarSettings(page, false);
  await expect(page.getByTestId('calendar-native-lifecycle-unavailable')).toBeVisible();
  await expect(page.getByTestId('calendar-native-create')).toHaveCount(0);
  await expect(page.getByTestId('calendar-native-delete')).toHaveCount(0);
  await expect(page.getByTestId('calendar-native-google-reconsent')).toBeVisible();
});

test('pending operation recovery reuses its stored idempotency key and refreshes only after confirmation', async ({ page, fixtureApi }) => {
  await fixtureApi;
  await openGoogleCalendarSettings(page);
  const keys: string[] = [];
  await page.route('**/api/accounts/account-1/provider-calendars', async route => {
    const body = route.request().postDataJSON() as { idempotencyKey: string };
    keys.push(body.idempotencyKey);
    await route.fulfill({ json: keys.length === 1 ? { state: 'pending', operationId: 'op-pending', retryAfterSeconds: 0 } : { state: 'confirmed', operationId: 'op-pending', collectionId: 'collection-new', localCalendarId: 'calendar-new', replayed: true } });
  });
  await page.getByTestId('calendar-native-name').fill('Recover remote');
  await page.getByTestId('calendar-native-create-submit').click();
  await expect(page.getByTestId('calendar-native-operation-check')).toBeVisible();
  await page.getByTestId('calendar-native-operation-check').click();
  await expect(page.getByTestId('calendar-native-operation-status')).toBeVisible();
  expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
  await expect(page.getByTestId('calendar-native-operation-check')).toHaveCount(0);
});

test('unknown operation blocks a blind retry and leaves projection untouched', async ({ page, fixtureApi }) => {
  await fixtureApi;
  await openGoogleCalendarSettings(page);
  let calls = 0;
  await page.route('**/api/accounts/account-1/provider-calendars', async route => { calls++; await route.fulfill({ json: { state: 'outcome_unknown', operationId: 'op-unknown' } }); });
  await page.getByTestId('calendar-native-name').fill('Unknown remote');
  await page.getByTestId('calendar-native-create-submit').click();
  await expect(page.getByTestId('calendar-native-operation-status')).toBeVisible();
  await expect(page.getByTestId('calendar-native-create-submit')).toBeDisabled();
  await expect(page.getByTestId('calendar-native-operation-check')).toHaveCount(0);
  expect(calls).toBe(1);
  await expect(page.getByTestId('calendar-manager-calendar')).toContainText('Remote calendar');
});
