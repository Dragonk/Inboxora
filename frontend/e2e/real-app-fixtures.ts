import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  authenticatedPage: async ({ page }, use) => {
    const username = process.env.PLAYWRIGHT_USERNAME || 'playwright@example.test';
    const password = process.env.PLAYWRIGHT_PASSWORD || 'PlaywrightPassword123!';
    const responses = [];
    page.on('response', response => {
      if (response.url().includes('/api/')) responses.push({ url: response.url(), status: response.status() });
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
    // Make the CE view explicit; this removes dependence on preference hydration timing
    // when the real app is opened immediately after login on a fresh CI browser context.
    await page.goto('/?list=1&reader=1');
    await use(page);
  },
});

export { expect };
