import { test, expect } from './fixtures.ts';
import { navigateModule } from './v3-fixtures.ts';

// These tests mock the mailbox; native service-worker coverage lives in real-app.spec.ts.
test.use({ serviceWorkers: 'block' });

async function liveMailbox(page, fixtureApi, reader = false, initialSize = 5) {
  page.__conversationMatrix = reader ? '11' : '10';
  page.__preferencesOverride = { markReadBehavior: 'manual', notificationSound: 'none' };
  const state = { unread: new Set([1, initialSize]), size: initialSize, listRequests: 0 };
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
  // Wait for the socket's required catch-up GET before installing test-specific
  // delayed responses. A live socket alone does not mean its coalesced refresh
  // has finished; otherwise that refresh can consume the test's first gate.
  const bootRefresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/mail/messages'
    && state.listRequests >= 2);
  await page.goto(`/?list=1&reader=${Number(reader)}`);
  await expect.poll(() => Boolean(socket)).toBe(true);
  await bootRefresh;
  const parent = () => page.locator('[data-thread-row-parent="true"]');
  await expect(parent()).toBeVisible();
  await parent().locator(`button[aria-label*='(${initialSize})']`).click();
  await expect(page.locator('[data-thread-row-child]')).toHaveCount(initialSize);
  return { state, parent, copy, send: data => socket.send(JSON.stringify(data)) };
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

// Mailbox and expansion requests are independent; a list-only refresh must not
// leave an up-to-date parent with obsolete cached children.
test('list-only refresh reconciles 14 cached children with 17 server messages', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-desktop', 'chromium-mobile-390'].includes(testInfo.project.name), 'desktop and mobile thread membership');
  const { state, parent } = await liveMailbox(page, fixtureApi, false, 14);
  state.size = 17;
  [15, 16, 17].forEach(n => state.unread.add(n));
  const previousRequests = state.listRequests;
  await page.evaluate(() => window.dispatchEvent(new Event('inboxora:refresh')));
  await expect.poll(() => state.listRequests).toBeGreaterThan(previousRequests);
  await expect(page.locator('[data-thread-row-child]')).toHaveCount(17);
  await expect(parent().locator("button[aria-label*='(17)']")).toBeVisible();
  await expect(parent()).toHaveAttribute('data-unread', 'true');
});

test('whole-thread read re-resolves membership instead of leaving three new replies unread', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-desktop', 'chromium-mobile-390'].includes(testInfo.project.name), 'desktop and mobile thread membership');
  const { state, parent } = await liveMailbox(page, fixtureApi, false, 14);
  const readIds = new Set();
  await page.route('**/api/mail/messages/bulk-read', async route => {
    const { ids, read } = route.request().postDataJSON();
    for (const id of ids) {
      readIds.add(id);
      const number = Number(id.split('-').at(-1));
      if (read) state.unread.delete(number);
      else state.unread.add(number);
    }
    await route.fulfill({ json: { ok: true } });
  });
  // No socket hint yet: even the parent's cached count is still 14.
  state.size = 17;
  [15, 16, 17].forEach(n => state.unread.add(n));
  if (testInfo.project.name === 'chromium-desktop') await parent().click({ button: 'right' });
  else await parent().getByRole('button', { name: /więcej|more/i }).click();
  await page.getByText(/oznacz jako przeczytan|mark as read/i).last().click();
  await expect.poll(() => readIds.size).toBe(17);
  await expect.poll(() => [...state.unread]).toEqual([]);
  await expect(parent()).toHaveAttribute('data-unread', 'false');
  await expect(page.locator('[data-thread-row-child]')).toHaveCount(17);
  await expect(parent().locator("button[aria-label*='(17)']")).toBeVisible();
  for (const read of [false, true]) {
    readIds.clear();
    if (testInfo.project.name === 'chromium-desktop') await parent().click({ button: 'right' });
    else await parent().getByRole('button', { name: /więcej|more/i }).click();
    await page.getByText(read ? /oznacz jako przeczytan|mark as read/i : /oznacz jako nieprzeczytan|mark as unread/i).last().click();
    await expect.poll(() => readIds.size).toBe(17);
    await expect.poll(() => state.unread.size).toBe(read ? 0 : 17);
    await expect(parent()).toHaveAttribute('data-unread', String(!read));
    await expect(page.locator('[data-thread-row-child]')).toHaveCount(17);
  }
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/mail/messages');
  await page.evaluate(() => window.dispatchEvent(new Event('inboxora:refresh')));
  await refreshed;
  await expect(parent()).toHaveAttribute('data-unread', 'false');
  await expect(parent().locator("button[aria-label*='(17)']")).toBeVisible();
});


test('a delayed expansion cannot restore obsolete membership after a whole-thread read', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-desktop', 'chromium-mobile-390'].includes(testInfo.project.name), 'desktop and mobile thread membership');
  const { state, parent, copy } = await liveMailbox(page, fixtureApi, false, 14);
  const oldMessages = Array.from({ length: 14 }, (_, index) => copy(index + 1));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let requested = 0;
  let heldRequest;
  await page.route('**/api/mail/thread/*', async route => {
    const first = ++requested === 1;
    if (first) { heldRequest = route.request(); await gate; }
    await route.fulfill({ json: { messages: first ? oldMessages : Array.from({ length: state.size }, (_, index) => copy(index + 1)) } });
  });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('inboxora:refresh', { detail: { refreshThreads: true } })));
  await expect.poll(() => requested).toBe(1);
  state.size = 17;
  [15, 16, 17].forEach(n => state.unread.add(n));
  const readIds = new Set();
  await page.route('**/api/mail/messages/bulk-read', async route => {
    for (const id of route.request().postDataJSON().ids) {
      readIds.add(id);
      state.unread.delete(Number(id.split('-').at(-1)));
    }
    await route.fulfill({ json: { ok: true } });
  });
  if (testInfo.project.name === 'chromium-desktop') await parent().click({ button: 'right' });
  else await parent().getByRole('button', { name: /więcej|more/i }).click();
  await page.getByText(/oznacz jako przeczytan|mark as read/i).last().click();
  await expect.poll(() => readIds.size).toBe(17);
  const staleResponse = page.waitForResponse(response => response.request() === heldRequest);
  release();
  await staleResponse;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('[data-thread-row-child]')).toHaveCount(17);
  await expect(parent()).toHaveAttribute('data-unread', 'false');
});

test('a removed representative does not cause a render and thread-fetch loop', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-desktop', 'chromium-mobile-390'].includes(testInfo.project.name), 'desktop and mobile thread membership');
  const { state, parent, copy } = await liveMailbox(page, fixtureApi, false, 14);
  let requested = 0;
  const previousListRequests = state.listRequests;
  await page.route('**/api/mail/thread/*', route => {
    requested++;
    return route.fulfill({ json: { messages: Array.from({ length: 16 }, (_, index) => copy(index + 1)) } });
  });
  // The list briefly advertises the newest copy after it has already been removed.
  state.size = 17;
  await page.evaluate(() => window.dispatchEvent(new Event('inboxora:refresh')));
  await expect(page.locator('[data-thread-row-child]')).toHaveCount(16);
  await expect(parent().locator("button[aria-label*='(16)']")).toBeVisible();
  // Browser-side interval observes network stability, not a fixed sleep before an assertion.
  await expect.poll(async () => {
    const before = requested;
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
    return requested === before;
  }).toBe(true);
  // Boot/visibility can deliver another genuine list snapshot. Each permits at
  // most the mismatch fetch and one count-correction fetch, not an unbounded loop.
  const refreshedSnapshots = Math.max(1, state.listRequests - previousListRequests);
  expect(requested).toBeLessThanOrEqual(2 * refreshedSnapshots);
});

test('expansion renders more than a mailbox page of children without a 14 or 17 message cap', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-desktop', 'chromium-mobile-390'].includes(testInfo.project.name), 'desktop and mobile thread membership');
  const { parent } = await liveMailbox(page, fixtureApi, false, 101);
  await expect(parent().locator("button[aria-label*='(101)']")).toBeVisible();
  await expect(page.locator('[data-thread-row-child]')).toHaveCount(101);
});

test('read completion updates the replacement representative of the same thread', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-desktop', 'chromium-mobile-390'].includes(testInfo.project.name), 'desktop and mobile thread membership');
  const { state, parent, copy } = await liveMailbox(page, fixtureApi, false, 17);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let requested = false;
  await page.route('**/api/mail/thread/*', async route => {
    requested = true;
    await gate;
    await route.fulfill({ json: { messages: Array.from({ length: 17 }, (_, index) => copy(index + 1)) } });
  });
  const readIds = new Set();
  await page.route('**/api/mail/messages/bulk-read', async route => {
    for (const id of route.request().postDataJSON().ids) {
      readIds.add(id);
      state.unread.delete(Number(id.split('-').at(-1)));
    }
    await route.fulfill({ json: { ok: true } });
  });
  if (testInfo.project.name === 'chromium-desktop') await parent().click({ button: 'right' });
  else await parent().getByRole('button', { name: /więcej|more/i }).click();
  await page.getByText(/oznacz jako przeczytan|mark as read/i).last().click();
  await expect.poll(() => requested).toBe(true);
  await page.route(url => url.pathname === '/api/mail/messages', route => route.fulfill({ json: {
    messages: [{ ...copy(14), message_count: 17, unread_count: state.unread.size }], total: 1,
  } }));
  await page.evaluate(() => window.dispatchEvent(new Event('inboxora:refresh')));
  await expect(page.locator('[data-msgid="conversation-gmail-copy-14"]')).toBeVisible();
  release();
  await expect.poll(() => readIds.size).toBe(17);
  await expect(parent()).toHaveAttribute('data-unread', 'false');
  await expect(page.locator('[data-thread-row-child]')).toHaveCount(17);
});

test('an explicit read finishes after account navigation without restoring the old expansion', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-desktop', 'chromium-mobile-390'].includes(testInfo.project.name), 'desktop and mobile explicit intent');
  const { state, parent, copy } = await liveMailbox(page, fixtureApi, false, 17);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let resolving = false;
  await page.route('**/api/mail/thread/*', async route => {
    resolving = true; await gate;
    await route.fulfill({ json: { messages: Array.from({ length: 17 }, (_, index) => copy(index + 1)) } });
  });
  const ids = new Set();
  await page.route('**/api/mail/messages/bulk-read', async route => {
    for (const id of route.request().postDataJSON().ids) { ids.add(id); state.unread.delete(Number(id.split('-').at(-1))); }
    await route.fulfill({ json: { ok: true } });
  });
  await page.route(url => url.pathname === '/api/mail/messages' && url.searchParams.get('accountId') === 'account-outlook', route => route.fulfill({ json: {
    messages: [{ id: 'other-account-row', account_id: 'account-outlook', folder: 'INBOX', subject: 'Other account', is_read: false, date: '2026-09-27T12:00:00Z' }], total: 1,
  } }));
  if (testInfo.project.name === 'chromium-desktop') await parent().click({ button: 'right' });
  else await parent().getByRole('button', { name: /więcej|more/i }).click();
  await page.getByText(/oznacz jako przeczytan|mark as read/i).last().click();
  await expect.poll(() => resolving).toBe(true);
  if (page.viewportSize().width < 768) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByText('Outlook fixture', { exact: true }).click();
  await expect(page.locator('[data-msgid="other-account-row"]')).toBeVisible();
  release();
  await expect.poll(() => ids.size).toBe(17);
  await expect.poll(() => state.unread.size).toBe(0);
  await expect(page.locator('[data-msgid="other-account-row"]')).toBeVisible();
  await expect(page.locator('[data-thread-row-child]')).toHaveCount(0);
});

for (const delivery of ['during', 'after']) {
  test(`a pre-write list snapshot delivered ${delivery} thread read cannot restore the unread aggregate`, async ({ page, fixtureApi }, testInfo) => {
    test.skip(!['chromium-desktop', 'chromium-mobile-390'].includes(testInfo.project.name), 'desktop and mobile list/write ordering');
    const { state, parent, copy } = await liveMailbox(page, fixtureApi, false, 17);
    let releaseOld, releaseFresh, releaseWrites;
    const oldGate = new Promise(resolve => { releaseOld = resolve; });
    const freshGate = new Promise(resolve => { releaseFresh = resolve; });
    const writeGate = new Promise(resolve => { releaseWrites = resolve; });
    let listRequests = 0;
    const oldParent = { ...copy(17), message_count: 17, unread_count: state.unread.size, is_read: false };
    await page.route(url => url.pathname === '/api/mail/messages', async route => {
      const first = ++listRequests === 1;
      await (first ? oldGate : freshGate);
      await route.fulfill({ json: { messages: [first ? oldParent : { ...copy(17), message_count: 17, unread_count: state.unread.size, is_read: state.unread.size === 0 }], total: 1 } });
    });
    const ids = new Set();
    await page.route('**/api/mail/messages/bulk-read', async route => {
      for (const id of route.request().postDataJSON().ids) { ids.add(id); state.unread.delete(Number(id.split('-').at(-1))); }
      await writeGate;
      await route.fulfill({ json: { ok: true } });
    });
    await page.evaluate(() => {
      window.__readCompletions = 0;
      window.addEventListener('inboxora:read-state', () => { window.__readCompletions++; });
      window.dispatchEvent(new Event('inboxora:refresh'));
    });
    try {
      await expect.poll(() => listRequests).toBe(1);
      if (testInfo.project.name === 'chromium-desktop') await parent().click({ button: 'right' });
      else await parent().getByRole('button', { name: /więcej|more/i }).click();
      await page.getByText(/oznacz jako przeczytan|mark as read/i).last().click();
      await expect.poll(() => ids.size).toBe(17);
      const deliverOld = async () => {
        const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/mail/messages');
        releaseOld(); await response;
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      };
      if (delivery === 'during') await deliverOld();
      releaseWrites();
      await expect.poll(() => page.evaluate(() => window.__readCompletions)).toBe(17);
      if (delivery === 'after') await deliverOld();
      // Fresh reconciliation remains blocked: it cannot mask a stale-data flash.
      await expect(parent()).toHaveAttribute('data-unread', 'false');
      await expect(page.locator('[data-thread-row-child]')).toHaveCount(17);
    } finally { releaseOld(); releaseFresh(); releaseWrites(); }
    await expect(parent()).toHaveAttribute('data-unread', 'false');
  });
}
