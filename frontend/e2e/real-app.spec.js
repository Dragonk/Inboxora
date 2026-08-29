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
    const goldenThread = page
      .locator('[data-msgid]')
      .filter({ hasText: 'Golden conversation thread' });
    const goldenRow = goldenThread.locator('[data-thread-row-parent="true"]');
    await expect(goldenRow).toBeVisible();
    await goldenRow.click();
    // Parent activation expands the native thread. On mobile it deliberately
    // remains list-only, so select an exact child as the shared reader-opening
    // interaction rather than assuming desktop navigation semantics.
    await expect(goldenRow).toHaveAttribute('aria-expanded', 'true');
    await goldenThread.locator('[data-thread-row-child]').first().click();
    const reader = page.locator('section[data-conversation-id]:visible');
    await expect(reader).toHaveCount(1);
    await expect(reader.locator('[data-logical-message-id]')).toHaveCount(5);
    await expect(reader.locator('iframe').first().contentFrame().getByText(/Fixture body (?:1|2|3|4|5)/, { exact: false })).toBeVisible();
  });
});
