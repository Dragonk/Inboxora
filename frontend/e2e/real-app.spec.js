import { test, expect } from './real-app-fixtures.js';

test.describe('real MailFlow conversation browser E2E', () => {
  test('opens a live conversation and renders reader content', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Gmail reply chain', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Outlook conversation', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Fastmail generic IMAP', { exact: true }).first()).toBeVisible();
    await page.getByText('Gmail reply chain', { exact: true }).first().click();
    await expect(page.locator('[data-conversation-id]')).toBeVisible();
    await expect(page.getByText('Fixture body 1', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: /expand|rozwiń/i }).first().click().catch(() => {});
  });
});

