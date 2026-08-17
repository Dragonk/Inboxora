import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  authenticatedPage: async ({ page }, use) => {
    const username = process.env.PLAYWRIGHT_USERNAME || 'playwright@example.test';
    const password = process.env.PLAYWRIGHT_PASSWORD || 'PlaywrightPassword123!';
    await page.goto('/login');
    await page.getByLabel(/Username|Nazwa użytkownika/i).fill(username);
    await page.getByLabel(/Password|Hasło/i).fill(password);
    await page.getByRole('button', { name: /Sign in|Zaloguj/i }).click();
    await page.waitForURL(url => url.pathname === '/');
    await use(page);
  },
});

export { expect };
