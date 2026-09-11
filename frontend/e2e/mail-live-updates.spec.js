import { test, expect } from './fixtures.js';
import { navigateModule } from './v3-fixtures.js';

async function liveMailbox(page, fixtureApi, reader = false) {
  page.__conversationMatrix = reader ? '11' : '10';
  page.__preferencesOverride = { markReadBehavior: 'manual', notificationSound: 'none' };
  const state = { unread: new Set([1, 5]), size: 5, listRequests: 0 };
  const copy = n => ({ id: `conversation-gmail-copy-${n}`, account_id: 'account-gmail', folder: 'INBOX', thread_id: 'conversation-gmail', thread_key: 'conversation-gmail', message_id: `<fixture-${n}>`, subject: 'Live conversation', from_email: 'sender@example.test', date: new Date(2026, 8, n).toISOString(), is_read: !state.unread.has(n), body_text: `Live message ${n}` });
  await page.route('**/api/accounts', route => route.fulfill({ json: fixtureApi.accounts.map(account => ({ ...account, enabled: true })) }));
  await page.route(url => url.pathname === '/api/mail/messages', route => {
    state.listRequests++;
    return route.fulfill({ json: { messages: [{ ...copy(state.size), message_count: state.size, unread_count: state.unread.size, is_read: state.unread.size === 0 }], total: 1 } });
  });
  await page.route('**/api/mail/thread/*', route => route.fulfill({ json: { messages: Array.from({ length: state.size }, (_, index) => copy(index + 1)) } }));
  await page.route('**/api/mail/unread-counts', route => route.fulfill({ json: { total: state.unread.size, byAccount: { 'account-gmail': state.unread.size } } }));
  let socket;
  await page.routeWebSocket('**/ws', ws => { socket = ws; ws.onMessage(message => { if (JSON.parse(message).type === 'ping') ws.send(JSON.stringify({ type: 'pong' })); }); });
  await page.goto(`/?list=1&reader=${Number(reader)}`);
  await expect.poll(() => Boolean(socket)).toBe(true);
  const parent = () => page.locator('[data-thread-row-parent="true"]');
  await expect(parent()).toBeVisible();
  await parent().locator("button[aria-label*='(5)']").click();
  await expect(page.locator('[data-thread-row-child]')).toHaveCount(5);
  return { state, parent, send: data => socket.send(JSON.stringify(data)) };
}

test('live flags update individual copies and the thread only becomes read after its last unread copy', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-desktop', 'chromium-mobile-390'].includes(testInfo.project.name), 'desktop and mobile live state');
  const { state, parent, send } = await liveMailbox(page, fixtureApi);
  await expect(parent()).toHaveAttribute('data-unread', 'true');
  state.unread.delete(5);
  send({ type: 'message_flags', changes: [{ id: 'conversation-gmail-copy-5', is_read: true }] });
  await expect(page.locator('[data-thread-row-child="conversation-gmail-copy-5"]')).toHaveAttribute('data-unread', 'false');
  await expect(parent()).toHaveAttribute('data-unread', 'true');
  state.unread.delete(1);
  send({ type: 'message_flags', changes: [{ id: 'conversation-gmail-copy-1', is_read: true }] });
  await expect(parent()).toHaveAttribute('data-unread', 'false');
  state.unread.add(1);
  send({ type: 'message_flags', changes: [{ id: 'conversation-gmail-copy-1', is_read: false }] });
  await expect(parent()).toHaveAttribute('data-unread', 'true');
});

test('incoming mail refreshes expanded membership and the unified inbox while Calendar is open', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-desktop', 'chromium-mobile-390'].includes(testInfo.project.name), 'desktop and mobile live state');
  const { state, parent, send } = await liveMailbox(page, fixtureApi);
  const incoming = () => send({ type: 'new_messages', accountId: 'account-gmail', folder: 'INBOX', count: 1, alertCount: 0, messages: [{ id: `conversation-gmail-copy-${state.size}`, subject: 'Live conversation' }] });
  state.size = 6; state.unread.add(6); incoming();
  await expect(page.locator('[data-thread-row-child="conversation-gmail-copy-6"]')).toBeVisible();
  await expect(parent()).toHaveAttribute('aria-expanded', 'true');
  await navigateModule(page, 'calendar');
  const before = state.listRequests;
  state.size = 7; state.unread.add(7); incoming();
  await expect.poll(() => state.listRequests).toBeGreaterThan(before);
  await expect(page.locator('[data-thread-row-child="conversation-gmail-copy-7"]')).toHaveCount(1);
  if (page.viewportSize().width < 768) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByRole('button', { name: /^Wszystkie skrzynki odbiorcze/ }).click();
  await expect(page.locator('[data-thread-row-child="conversation-gmail-copy-7"]')).toBeVisible();
  await expect(parent()).toHaveAttribute('data-unread', 'true');
});

test('an incoming reply appears in the open reader without replacing the selected body', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'reader live membership');
  const { state, send } = await liveMailbox(page, fixtureApi, true);
  const reader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
  const current = reader.locator('article[data-physical-copy-id="conversation-gmail-copy-5"]');
  await expect(current).toHaveAttribute('data-conversation-message-state', 'expanded');
  await expect(current.locator('iframe')).toBeVisible();
  await current.locator('iframe').evaluate(element => { window.__liveBody = element; });
  state.size = 6; state.unread.add(6);
  send({ type: 'new_messages', accountId: 'account-gmail', folder: 'INBOX', count: 1, alertCount: 0, messages: [{ id: 'conversation-gmail-copy-6' }] });
  await expect(reader.locator('article[data-physical-copy-id="conversation-gmail-copy-6"]')).toBeVisible();
  await expect(current).toHaveAttribute('data-conversation-message-state', 'expanded');
  expect(await current.locator('iframe').evaluate(element => element === window.__liveBody)).toBe(true);
});
