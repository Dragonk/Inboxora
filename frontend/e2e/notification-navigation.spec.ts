import type { WebSocketRoute } from '@playwright/test';
import { test, expect } from './fixtures.ts';
import { setupV3, navigateModule } from './v3-fixtures.ts';

test.use({ serviceWorkers: 'block' });

for (const matrix of ['00', '11']) {
  test(`incoming toast opens the requested physical email from Calendar (${matrix})`, async ({ page, fixtureApi }) => {
    await fixtureApi; await setupV3(page);
    page.__languageOverride = 'en'; page.__conversationMatrix = matrix;
    page.__preferencesOverride = { notificationSound: 'none', autoLockMinutes: 0 };
    let socket: WebSocketRoute | undefined;
    await page.routeWebSocket('**/ws', ws => {
      socket = ws;
      ws.onMessage(message => { if (String(message).includes('ping')) ws.send(JSON.stringify({ type: 'pong' })); });
    });
    const resolutions: string[] = []; const bodyReads: string[] = [];
    page.on('request', request => {
      const match = new URL(request.url()).pathname.match(/^\/api\/mail\/messages\/([^/]+)\/body$/);
      if (match) bodyReads.push(decodeURIComponent(match[1]));
      const url = new URL(request.url());
      if (/^\/api\/mail\/conversations\/[^/]+\/logical-messages\/[^/]+\/body$/.test(url.pathname) && url.searchParams.get('copyId')) bodyReads.push(url.searchParams.get('copyId')!);
    });
    await page.route('**/api/mail/resolve-message?**', route => {
      const url = new URL(route.request().url());
      resolutions.push(`${url.searchParams.get('accountId')}:${url.searchParams.get('ref')}`);
      return route.fulfill({ json: {
        id: 'conversation-gmail-copy-3', account_id: 'account-gmail', folder: 'INBOX', subject: 'Gmail reply chain',
        from_email: 'sender@gmail.test', date: '2026-01-03T09:00:00Z', is_read: true,
        thread_id: matrix === '11' ? 'conversation-gmail' : null, thread_key: matrix === '11' ? 'conversation-gmail' : null,
        message_count: matrix === '11' ? 5 : 1, message_id: '<fixture-3>',
      } });
    });
    await page.goto('/'); await expect(page.getByTestId('message-list-scroll')).toBeVisible();
    await navigateModule(page, 'calendar');
    await expect.poll(() => Boolean(socket)).toBe(true);
    socket!.send(JSON.stringify({ type: 'new_messages', accountId: 'account-gmail', folder: 'INBOX', count: 1,
      messages: [{ id: 'conversation-gmail-copy-3', fromName: 'Notification sender', fromEmail: 'sender@gmail.test', subject: 'Open this exact email' }] }));
    const toast = page.getByRole('button').filter({ hasText: 'Open this exact email' });
    await expect(toast).toBeVisible();
    await toast.click();
    await expect(page.getByTestId('calendar-page')).toHaveCount(0);
    await expect.poll(() => resolutions).toEqual(['account-gmail:conversation-gmail-copy-3']);
    if (matrix === '11') {
      const target = page.locator('article[data-physical-copy-id="conversation-gmail-copy-3"]');
      await expect(target).toBeVisible();
      await expect(target).toHaveAttribute('data-conversation-message-state', 'expanded');
    }
    await expect.poll(() => bodyReads.includes('conversation-gmail-copy-3')).toBe(true);
  });
}
