import { test, expect } from './fixtures.js';

test('conversation read updates the account badge before the server write returns', async ({ page, fixtureApi }, info) => {
  test.skip(!['chromium-desktop', 'chromium-mobile-390'].includes(info.project.name), 'reader counter coverage');
  await fixtureApi;
  page.__conversationMatrix = '01';
  page.__unreadCopies = ['conversation-gmail-copy-1', 'conversation-gmail-copy-3'];
  let release;
  page.__bulkReadGates = { true: { promise: new Promise(resolve => { release = resolve; }) } };
  await page.goto('/');
  await expect(page.locator('[data-ce-reader-enabled]:visible').first()).toHaveAttribute('data-ce-reader-enabled', 'true');
  const badge = page.locator('[data-account-id="account-gmail"][data-unread-count]').first();
  await expect(badge).toHaveAttribute('data-unread-count', '2');
  try {
    await page.locator('[data-msgid="conversation-gmail-copy-3"]:visible').click();
    await expect.poll(() => page.__bulkReadStarts?.length || 0).toBeGreaterThan(0);
    await expect(badge).toHaveAttribute('data-unread-count', '1');
  } finally { page.__unreadCopies = ['conversation-gmail-copy-1']; release(); }
  await expect(badge).toHaveAttribute('data-unread-count', '1');
});

test('a service-worker arrival refreshes the open message list without navigation', async ({ page, fixtureApi }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'foreground push coverage');
  await fixtureApi; page.__conversationMatrix = '00'; await page.goto('/');
  await expect(page.locator('[data-msgid="conversation-gmail-copy-1"]:visible')).toBeVisible();
  const refreshed = page.waitForRequest(request => new URL(request.url()).pathname === '/api/mail/messages');
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'inboxora_mail_changed' } })));
  await refreshed;
});
