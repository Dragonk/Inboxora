import { test, expect } from './fixtures.ts';

test('DAV discovery URLs and passwords copy with accessible success/error feedback on narrow screens', async ({ page, fixtureApi }) => {
  await fixtureApi;
  await page.route('**/api/dav-credentials', async route => {
    const created = route.request().method() === 'POST';
    await route.fulfill({ json: created
      ? { credential: { id: 'device', label: 'Phone', created_at: '2026-01-01T00:00:00Z', max_dav_mode: 'read_only' }, secret: 'dav-device-secret-once' }
      : { credentials: [] } });
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => {
        if (value.endsWith('/caldav')) throw new Error('Permission denied');
        document.documentElement.dataset.copied = value;
      },
    } });
  });
  await page.goto('/');
  if (page.viewportSize().width < 768) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if (page.viewportSize().width < 768) await page.getByTestId('mobile-settings').click();
  else await page.getByText(/^Ustawienia$|^Settings$/i).first().click();
  await page.getByRole('button', { name: /^Dostęp DAV$|^DAV access$/i }).click();
  const carddav = page.getByRole('button', { name: /— CardDAV$/ });
  await carddav.click();
  await expect(page.getByRole('status')).toContainText(/copied|skopiowano/i);
  await expect(page.locator('html')).toHaveAttribute('data-copied', /\/.well-known\/carddav$/);
  await page.getByRole('button', { name: /— CalDAV$/ }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  // Failure never announces a success for the failed URL.
  await expect(page.getByRole('status')).toHaveCount(1);
  await page.getByRole('textbox', { name: /Nazwa urządzenia|Device name/i }).fill('Phone');
  await page.getByTestId('dav-credential-max-mode').selectOption('read_only');
  await page.getByRole('button', { name: /create|utwórz/i }).click();
  await expect(page.getByText('dav-device-secret-once', { exact: true })).toBeVisible();
  const passwordCopy = page.locator('section').filter({ hasText: 'dav-device-secret-once' }).getByRole('button');
  // Copy buttons have target-specific accessible names rather than three identical labels.
  await expect(page.getByRole('button', { name: /—/ })).toHaveCount(3);
  await passwordCopy.first().click();
  await expect(page.locator('html')).toHaveAttribute('data-copied', 'dav-device-secret-once');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
