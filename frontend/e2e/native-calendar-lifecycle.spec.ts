import { test, expect } from './fixtures.ts';

async function openSettings(page: import('@playwright/test').Page) {
  await page.goto('/');
  if (page.viewportSize()!.width < 768) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if (page.viewportSize()!.width < 768) await page.getByTestId('mobile-settings').click();
  else await page.getByText(/^Ustawienia$|^Settings$/i).first().click();
  const panel = page.locator('.admin-panel');
  await expect(panel).toBeVisible();
  return panel;
}

test('calendar settings are reachable from the account menu', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const panel = await openSettings(page);
  await expect(panel.getByTestId('admin-tab-calendar')).toBeVisible();
  await expect(panel.getByTestId('admin-tab-accounts')).toBeVisible();
});

test('calendar settings keep calendar and contact account areas distinct', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const panel = await openSettings(page);
  await expect(panel.getByTestId('admin-tab-calendar')).toBeVisible();
  await expect(panel.getByTestId('admin-tab-contacts')).toBeVisible();
});

test('settings expose the DAV and integration administration areas', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const panel = await openSettings(page);
  await expect(panel.getByTestId('admin-tab-dav-credentials')).toBeVisible();
  await expect(panel.getByTestId('admin-tab-integrations')).toBeVisible();
});

test('settings can be closed without changing the current application shell', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const panel = await openSettings(page);
  await panel.getByRole('button', { name: /^Zamknij$|^Close$/i }).first().click();
  await expect(page.getByTestId('sidebar-user-menu')).toBeVisible();
  await expect(page.locator('.admin-panel')).toHaveCount(0);
});
