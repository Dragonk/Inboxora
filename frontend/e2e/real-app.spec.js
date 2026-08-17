import { test, expect } from './real-app-fixtures.js';

test.describe('real MailFlow conversation browser E2E', () => {
  test('logs in and renders live conversation data', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Gmail reply chain', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Outlook conversation', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Fastmail generic IMAP', { exact: true }).first()).toBeVisible();
  });
});
