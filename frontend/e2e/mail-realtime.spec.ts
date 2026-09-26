import { expect, type WebSocketRoute } from '@playwright/test';
import { test } from './fixtures.ts';

// Browser contract tests use an HTTP/WS boundary fixture. The separate backend
// PostgreSQL + real WebSocket suite verifies that real provider commits emit it.
for (const signal of ['mail_state_changed', 'new_messages', 'lost-event'] as const) {
  test(`PR14: ${signal} updates an already open list/title without F5`, async ({ page, fixtureApi }) => {
    void fixtureApi;
    let socket: WebSocketRoute | undefined;
    let reads = 0;
    let unread = 0;
    const rows: Array<Record<string, unknown>> = [];
    await page.routeWebSocket('**/ws', ws => {
      socket = ws;
      ws.onMessage(message => {
        if (String(message).includes('ping')) ws.send(JSON.stringify({ type: 'pong' }));
      });
      ws.send(JSON.stringify({ type: 'connected' }));
    });
    await page.route('**/api/auth/preferences**', route => route.fulfill({ json: {
      language: 'en', threadedView: false, showAppBadge: true,
      conversation_list_view_enabled: false, conversation_reader_view_enabled: false,
      notificationSound: 'none', autoLockMinutes: 0,
    } }));

    // This test exercises the Unified Inbox. The production account payload marks
    // enabled accounts explicitly; without that field accountAffectsUnifiedInbox()
    // correctly treats the fixture account as excluded.
    await page.route('**/api/accounts', route => route.fulfill({ json: [
      {
        id: 'account-outlook',
        name: 'Outlook fixture',
        email_address: 'me@outlook.test',
        color: '#0078d4',
        enabled: true,
        include_in_unified_inbox: true,
      },
    ] }));
    await page.route(url => url.pathname === '/api/mail/messages', route => {
      reads += 1;
      return route.fulfill({ json: { messages: rows, total: rows.length } });
    });
    await page.route('**/api/mail/unread-counts', route => route.fulfill({ json: {
      total: unread, byAccount: { 'account-outlook': unread },
    } }));
    await page.clock.install();
    await page.goto('/');
    await expect.poll(() => reads).toBeGreaterThan(0);
    await expect.poll(() => Boolean(socket)).toBe(true);
    await page.clock.runFor(2000); // finish the first connection's catch-up
    const initial = reads;
    const navigationMarker = await page.evaluate(() => {
      const key = `pr14-${Math.random()}`;
      (window as unknown as { pr14NavigationMarker: string }).pr14NavigationMarker = key;
      return key;
    });
    const subject = `PR14 ${signal} arrival`;
    rows.unshift({ id: '00000000-0000-0000-0000-00000000fa14', account_id: 'account-outlook',
      folder: 'INBOX', subject, message_id: '<pr14@example.test>', snippet: 'Live arrival',
      from_email: 'sender@example.test', from_name: 'Sender', date: new Date().toISOString(),
      is_read: false, is_deleted: false, is_starred: false });
    unread = 1;
    if (signal === 'mail_state_changed') {
      socket!.send(JSON.stringify({ type: signal, accountId: 'account-outlook', folders: null }));
    } else if (signal === 'new_messages') {
      socket!.send(JSON.stringify({ type: signal, accountId: 'account-outlook', folder: 'INBOX', count: 1, messages: [], alertCount: 0 }));
    } else {
      // Socket is still open and answers ping/pong, but no mail event is delivered.
      await page.clock.fastForward(60_000);
    }
    await page.clock.runFor(2500);
    await expect(page.getByText(subject, { exact: true })).toBeVisible();
    await expect(page).toHaveTitle('(1) Inboxora');
    expect(reads).toBeGreaterThan(initial);
    expect(await page.evaluate(() => (window as unknown as { pr14NavigationMarker: string }).pr14NavigationMarker)).toBe(navigationMarker);
    unread = 0;
    rows[0].is_read = true;
    socket!.send(JSON.stringify({ type: 'mail_state_changed', accountId: 'account-outlook', folders: ['INBOX'] }));
    await page.clock.runFor(2000);
    await expect(page).toHaveTitle('Inboxora');
    await expect(page.getByText(subject, { exact: true })).toBeVisible();
  });
}
