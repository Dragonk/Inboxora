import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  authenticatedPage: async ({ page }, use) => {
    const username = process.env.PLAYWRIGHT_USERNAME || 'playwright@example.test';
    const password = process.env.PLAYWRIGHT_PASSWORD || 'PlaywrightPassword123!';
    // Authenticate against the real backend before booting the SPA. page.request
    // shares cookie storage with this browser context, so the application starts
    // already authenticated. This avoids booting MailApp once after the login
    // redirect and immediately tearing its WebSocket down with a second page.goto().
    const login = await page.request.post('/api/auth/login', {
      headers: {
        'X-Requested-With': 'MailFlow',
      },
      data: {
        username,
        password,
      },
    });

    expect(login.status(), await login.text()).toBe(200);

    // Boot the real application exactly once with the CE mode explicitly selected.
    await page.goto('/?list=1&reader=1', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/\?list=1&reader=1$/);
    await use(page);
  },
});

export { expect };
