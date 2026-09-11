import { test, expect } from './fixtures.js';
import { setupV3, navigateModule } from './v3-fixtures.js';
import { openContactBooks, returnToMail } from './navigation.js';

async function openSettings(page) {
  if (page.viewportSize().width < 768) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if (page.viewportSize().width < 768) await page.getByTestId('mobile-settings').click();
  else await page.getByText('Ustawienia', { exact: true }).first().click();
}

test('Calendar has separate preferences and global navigation applies in every mobile module', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-desktop', 'chromium-mobile-390'].includes(testInfo.project.name), 'settings behavior');
  await setupV3(page);
  const saved = [];
  await page.route('**/api/auth/preferences**', route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    saved.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  await openSettings(page);
  const panel = page.locator('.admin-panel');
  await panel.locator('.admin-tab').filter({ hasText: /^Kalendarz$/ }).click();
  await expect(page.getByTestId('calendar-settings')).toBeVisible();
  await expect(page.getByTestId('mobile-navigation-position-setting')).toHaveCount(0);
  await page.getByTestId('calendar-week-start-setting').getByRole('button', { name: 'Niedziela' }).click();
  await page.getByTestId('calendar-work-day-6').check();
  await page.getByTestId('calendar-work-hours-start').fill('08:00');
  await expect.poll(() => saved.some(value => String(value.calendarWeekStartsOn) === '0')).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('calendar-settings.png') });
  await panel.locator('.admin-tab').filter({ hasText: /^Wygląd$/ }).click();
  await panel.locator('.admin-subtab').filter({ hasText: /^Układ$/ }).click();
  await expect(page.getByTestId('calendar-settings')).toHaveCount(0);
  await page.getByTestId('mobile-navigation-position-setting').getByRole('button', { name: 'Na dole' }).click();
  await expect.poll(() => saved.some(value => value.mobileNavigationPosition === 'bottom')).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('navigation-settings.png') });
  await panel.getByRole('button', { name: 'Zamknij', exact: true }).first().click();
  if (page.viewportSize().width < 768) {
    for (const module of ['calendar', 'contacts']) {
      await navigateModule(page, module);
      const bar = page.getByTestId('mobile-topbar');
      await expect(bar).toHaveAttribute('data-position', 'bottom');
      const box = await bar.boundingBox();
      expect(box.y + box.height).toBe(page.viewportSize().height);
      await expect(bar.getByTestId(module === 'calendar' ? 'calendar-header-new' : 'contacts-header-new')).toBeVisible();
    }
    await returnToMail(page);
    await expect(page.getByTestId('message-list-scroll')).toBeVisible();
    await expect(page.getByTestId('mobile-topbar')).toHaveAttribute('data-position', 'bottom');
    await expect(page.getByTestId('mobile-topbar').getByRole('button', { name: 'Napisz' })).toBeVisible();
  }
  await fixtureApi;
});

test('mobile drawer highlights only the current module and book selection includes all books', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile-390', 'mobile module navigation');
  await setupV3(page);
  await page.route('**/api/accounts', route => route.fulfill({ json: fixtureApi.accounts.map(account => ({ ...account, enabled: true })) }));
  await page.goto('/');
  for (const module of ['calendar', 'contacts']) {
    await navigateModule(page, module);
    await page.getByTestId('mobile-topbar-menu').click();
    await expect(page.getByTestId('mobile-sidebar').locator('[aria-current="page"]')).toHaveCount(1);
    await expect(page.getByTestId(`${module}-nav-mobile`)).toHaveAttribute('aria-current', 'page');
    await page.getByTestId(`${module}-nav-mobile`).click();
  }
  await openContactBooks(page);
  await page.getByRole('button', { name: 'Prywatna', exact: true }).click();
  await expect(page.locator('.mobile-module-title')).toContainText('Prywatna');
  await openContactBooks(page);
  const all = page.getByTestId('contacts-books-dialog').locator('.contacts-books button').first();
  await all.click();
  await expect(page.getByRole('button', { name: 'Anna Kowalska', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Anna Kowalska', exact: true }).click();
  const create = page.getByTestId('contacts-header-new');
  await expect(create).toBeEnabled();
  await expect(create.locator('svg')).toBeVisible();
  await create.click();
  await expect(page.getByRole('button', { name: /^Zapisz/ })).toBeVisible();
});

test('the Chinese resource locale renders mail dates, contact dates and settings units without Intl errors', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile-390', 'Intl locale compatibility');
  await fixtureApi;
  await setupV3(page);
  page.__languageOverride = 'zhCN';
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByTestId('message-list-scroll')).toBeVisible();
  await navigateModule(page, 'contacts');
  await page.getByRole('button', { name: 'Anna Kowalska', exact: true }).click();
  await expect(page.getByTestId('contacts-mobile-detail')).toBeVisible();
  await navigateModule(page, 'calendar');
  await expect(page.getByTestId('calendar-grid')).toBeVisible();
  await openSettings(page);
  await page.locator('.admin-tab').filter({ hasText: /^外观$/ }).click();
  await page.locator('.admin-subtab').filter({ hasText: /^布局$/ }).click();
  await expect(page.getByTestId('mobile-navigation-position-setting')).toBeVisible();
  expect(errors).toEqual([]);
});
