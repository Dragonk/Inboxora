import { test, expect } from './fixtures.ts';

test('calendar management hides a sidebar entry without changing event selection', async ({ page, fixtureApi }) => {
  await fixtureApi;
  let hidden = false;
  const writes: unknown[] = [];
  await page.route('**/api/calendar/sources', route => route.fulfill({ json: { sources: [] } }));
  await page.route('**/api/calendar/presentation', route => route.fulfill({ json: { sources: [{ id: 'local', kind: 'local', label: 'Local test account', accountId: null, identityLabel: null, featureEnabled: true, canSync: false, collapsed: false }], groups: [{
    id: 'local', kind: 'local', label: 'Local test account', accountId: null,
    identityLabel: null, featureEnabled: true, canSync: false, collapsed: false,
    calendars: [{ id: 'calendar-personal', sourceId: 'local', displayName: 'Personal', readOnly: false, selected: true, sidebarHidden: hidden }],
  }] } }));
  await page.route('**/api/calendar/presentation/calendars/calendar-personal', async route => {
    const body = route.request().postDataJSON();
    writes.push(body);
    hidden = body.sidebarHidden;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  const mobile = page.viewportSize()!.width < 768;
  if (mobile) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if (mobile) await page.getByTestId('mobile-settings').click();
  else await page.getByText(/^Ustawienia$|^Settings$/i).first().click();
  if (mobile) await page.getByRole('button', { name: /^Kalendarz · Konta$|^Calendar · Accounts$/ }).click();
  else await page.getByRole('button', { name: /^Konta$|^Accounts$/ }).nth(1).click();
  const manager = page.getByTestId('calendar-settings-manager');
  await expect(manager).toBeVisible();
  await expect(manager.getByTestId('calendar-manager-source').locator('small')).toHaveText(/Moje kalendarze|My calendars/);
  await expect(manager.getByRole('checkbox')).toHaveCount(0);
  const visibility = manager.getByTestId('calendar-manager-visibility');
  await visibility.click();
  await expect(visibility).toHaveText(/Pokaż|Show/);
  expect(writes).toEqual([{ sidebarHidden: true }]);
  await visibility.click();
  await expect(visibility).toHaveText(/Ukryj|Hide/);
  expect(writes).toEqual([{ sidebarHidden: true }, { sidebarHidden: false }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('contact book management opens the canonical settings section', async ({ page, fixtureApi }) => {
  await fixtureApi;
  await page.route('**/api/contacts/address-books', route => route.fulfill({ json: { addressBooks: [] } }));
  await page.goto('/');
  const mobile = page.viewportSize()!.width < 768;
  if (mobile) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId(mobile ? 'contacts-nav-mobile' : 'contacts-nav-primary').click();
  if (mobile) await page.getByTestId('contacts-address-books').click();
  await page.getByTestId('contacts-manage-books').click();
  await expect(page.getByTestId('contacts-settings')).toBeVisible();
  await expect(page.getByTestId('contacts-books-manager')).toBeVisible();
  await expect(page.getByTestId('contacts-books-manager')).not.toHaveAttribute('role', 'dialog');
  await expect(page.getByTestId('contacts-manager-create-book')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
