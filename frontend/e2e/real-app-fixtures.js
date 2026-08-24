import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  authenticatedPage: async ({ page }, use) => {
    const username = process.env.PLAYWRIGHT_USERNAME || 'playwright@example.test';
    const password = process.env.PLAYWRIGHT_PASSWORD || 'PlaywrightPassword123!';
    const responses = [];
    page.on('response', async response => {
      if (response.url().includes('/api/')) {
        let body = null;
        if (response.url().includes('/api/mail/conversations') && response.request().method() === 'GET') body = await response.json().catch(() => null);
        responses.push({ url: response.url(), status: response.status(), body });
      }
    });
    await page.goto('/login');
    await page.getByLabel(/Username|Nazwa użytkownika/i).fill(username);
    await page.getByLabel(/Password|Hasło/i).fill(password);
    await page.getByRole('button', { name: /Sign in|Zaloguj/i }).click();
    // A failed login can legitimately leave the browser on /login while the
    // POST still returns a response. Do not let that produce a false-positive
    // real-app run: only the authenticated root is a valid landing page.
    await page.waitForURL(url => url.pathname === '/', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/$/);
    await expect.poll(() => responses.some(item => item.url.includes('/api/auth/login') && item.status === 200)).toBe(true);
    await expect.poll(() => responses.some(item => item.url.includes('/api/mail/conversations') && item.status === 200 && (item.body?.conversations?.length || 0) > 0), { timeout: 15_000 }).toBe(true);
    await use(page);
  },
});

export { expect };
