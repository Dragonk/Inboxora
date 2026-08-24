import { test, expect } from './real-app-fixtures.js';

test.describe('real MailFlow conversation browser E2E', () => {
  test('opens a live conversation and renders reader content', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Golden conversation thread', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Gmail reply chain', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Outlook conversation', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Fastmail generic IMAP', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Rozwiń|Zwiń|Expand|Collapse/i }).first()).toBeVisible();
    const goldenRow = page.getByRole('button', { name: /Rozwiń rozmowę: Golden conversation thread|Expand conversation: Golden conversation thread/i });
    await goldenRow.click();
    await expect(page.locator('[data-logical-message-id]')).toHaveCount(5);
    await page.locator('[data-logical-message-id]').first().click();
    await expect(page.locator('[data-conversation-id]')).toBeVisible();
    await expect(page.locator('[data-logical-message-id]').count()).resolves.toBeGreaterThan(0);
    await expect(page.locator('iframe').first().contentFrame().getByText(/Fixture body (?:1|2|3|4|5)/, { exact: false })).toBeVisible();
    await page.getByRole('button', { name: /expand|rozwiń/i }).first().click().catch(() => {});
  });
});
