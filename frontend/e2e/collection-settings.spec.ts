import { test, expect } from './fixtures.ts';
import { setupV3, navigateModule } from './v3-fixtures.ts';

async function openCalendar(page: any) {
  await navigateModule(page, 'calendar');
  if (page.viewportSize().width < 768) {
    await page.getByTestId('calendar-mobile-panel').click();
    await expect(page.getByTestId('calendar-mobile-dock')).toBeVisible();
  }
  const sidebar = page.getByTestId('calendar-sidebar');
  await expect(sidebar).toBeVisible();
  return sidebar;
}

test('calendar sidebar selection and collapse are independent', async ({ page, fixtureApi }) => {
  await fixtureApi; await setupV3(page); await page.goto('/');
  const sidebar = await openCalendar(page);
  await expect(sidebar).toBeVisible();
  const group = sidebar.getByTestId('calendar-source-group').first();
  const row = sidebar.locator('[data-resource-id="calendar-personal"]');
  await expect(row).toBeVisible();
  const selected = row.locator('input[type="checkbox"]');
  await expect(selected).toBeChecked();
  const collapseRequests: unknown[] = [];
  await page.route('**/api/calendar/presentation/sources/*', route => {
    if (route.request().method() === 'PATCH') collapseRequests.push(route.request().postDataJSON());
    return route.fallback();
  });
  const collapse = group.getByTestId('calendar-source-collapse');
  await collapse.click();
  await expect.poll(() => collapseRequests.length).toBe(1);
  expect(collapseRequests[0]).toMatchObject({ collapsed: true });
  await expect(selected).toBeChecked();
});

test('calendar sidebar exposes per-calendar color palette on desktop and mobile', async ({ page, fixtureApi }) => {
  await fixtureApi; await setupV3(page); await page.goto('/');
  const sidebar = await openCalendar(page);
  const row = sidebar.locator('[data-resource-id="calendar-personal"]');
  await expect(row.getByTestId('calendar-color-button')).toBeVisible();
  await row.getByTestId('calendar-color-button').click();
  const palette = page.getByRole('dialog', { name: /Kolor|Color/ });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('button')).not.toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
});

test('contact settings use the current non-dialog manager shell', async ({ page, fixtureApi }) => {
  await fixtureApi; await setupV3(page); await page.goto('/');
  await page.route('**/api/contacts/presentation', route => route.request().method() === 'PATCH'
    ? route.fulfill({ json: { ok: true } })
    : route.fulfill({ json: { addressBookIds: [] } }));
  await navigateModule(page, 'contacts');
  await page.getByTestId('contacts-manage-books').click();
  await expect(page.getByTestId('contacts-books-manager')).toBeVisible();
  await expect(page.getByTestId('contacts-books-manager')).not.toHaveAttribute('role', 'dialog');
  await page.getByRole('tab').nth(1).click();
  await expect(page.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true');
});
