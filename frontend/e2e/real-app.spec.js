import { test, expect } from './real-app-fixtures.js';

test.describe('real MailFlow conversation browser E2E', () => {
  test('opens a live conversation and renders reader content', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Gmail reply chain', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Outlook conversation', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Fastmail generic IMAP', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Rozwiń|Zwiń|Expand|Collapse/i }).first()).toBeVisible();
    const gmailRow = page.getByRole('button', { name: /Rozwiń rozmowę: Gmail reply chain|Expand conversation: Gmail reply chain/i });
    await gmailRow.click();
    await page.locator('[data-logical-message-id]').first().click();
    await expect(page.locator('[data-conversation-id]')).toBeVisible();
    await expect(page.locator('[data-logical-message-id]').count()).resolves.toBeGreaterThan(0);
    await expect(page.locator('iframe').first().contentFrame().getByText(/Fixture body (?:1|2|3)/, { exact: false })).toBeVisible();
    await page.getByRole('button', { name: /expand|rozwiń/i }).first().click().catch(() => {});
  });
});
