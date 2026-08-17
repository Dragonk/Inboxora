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
    await page.waitForURL(url => url.pathname === '/');
    await expect.poll(() => responses.some(item => item.url.includes('/api/auth/login') && item.status === 200)).toBe(true);
    await use({ page, responses });
  },
});

export { expect };
