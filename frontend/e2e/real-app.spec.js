import { test, expect } from './real-app-fixtures.js';

// This spec requires an explicitly provisioned live backend, database and account
// fixture. The default Playwright command intentionally starts only Vite plus the
// browser-level API mocks used by the other specs, so it must not attempt a login.
test.skip(process.env.PLAYWRIGHT_REAL_APP !== '1', 'requires PLAYWRIGHT_REAL_APP=1 and a provisioned MailFlow backend');

test.describe('real MailFlow conversation browser E2E', () => {
  test('opens a live conversation and renders reader content', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Golden conversation thread', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Gmail reply chain', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Outlook conversation', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Fastmail generic IMAP', { exact: true }).first()).toBeVisible();
    const goldenRow = page
      .locator('[data-msgid]')
      .filter({ hasText: 'Golden conversation thread' })
      .locator('[data-thread-row-parent="true"]');
    await expect(goldenRow).toBeVisible();
    await goldenRow.click();
    // The list is intentionally folder-scoped (the real app starts in Inbox),
    // so only the two Inbox logical messages are previewed there. Opening the
    // conversation loads the complete cross-folder detail and must expose all
    // five LogicalMessages in the reader.
    await expect(page.locator('[data-logical-message-id]')).toHaveCount(2);
    await page.locator('[data-logical-message-id]').first().click();
    await expect(page.locator('[data-conversation-id]')).toBeVisible();
    await expect(page.locator('[data-conversation-id] [data-logical-message-id]')).toHaveCount(5);
    await expect(page.locator('[data-conversation-id] [data-logical-message-id]').count()).resolves.toBeGreaterThan(0);
    await expect(page.locator('iframe').first().contentFrame().getByText(/Fixture body (?:1|2|3|4|5)/, { exact: false })).toBeVisible();
  });
});
