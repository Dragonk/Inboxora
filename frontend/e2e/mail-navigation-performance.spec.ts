import { test, expect } from './fixtures.ts';

test.use({ serviceWorkers: 'block' });

async function mailbox(page, fixtureApi) {
  page.__conversationMatrix = '00';
  page.__languageOverride = 'en';
  await page.route('**/api/accounts', route => route.fulfill({ json: fixtureApi.accounts.map(account => ({ ...account, enabled: true })) }));
  const state = { held: false, requests: [], releases: [], revision: 1 };
  await page.route(url => url.pathname === '/api/mail/messages', async route => {
    const url = new URL(route.request().url());
    const account = url.searchParams.get('accountId');
    const scope = account || 'unified';
    state.requests.push(scope);
    const revision = state.revision;
    if (state.held) await new Promise(resolve => state.releases.push(resolve));
    const rows = (account ? fixtureApi.accounts.filter(row => row.id === account) : fixtureApi.accounts).map(row => ({
      id: `nav-${row.id}`, account_id: row.id, folder: 'INBOX', is_read: false, subject: `Navigation ${row.name} v${revision}`,
      message_id: `<nav-${row.id}@example.test>`, date: '2026-09-27T10:00:00Z', from_email: 'sender@example.test', snippet: `scope=${scope}`,
    }));
    await route.fulfill({ json: { messages: rows, total: rows.length } });
  });
  let socket;
  await page.routeWebSocket('**/ws*', ws => { socket = ws; });
  // The initial WebSocket handshake legitimately invalidates pre-handshake
  // snapshots. Warm navigation starts after its mandatory catch-up response.
  const bootRefresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/mail/messages'
    && state.requests.filter(scope => scope === 'unified').length >= 2);
  await page.goto('/');
  await bootRefresh;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('[data-msgid="nav-account-gmail"]')).toBeVisible();
  const navigate = async (name = null) => {
    if (page.viewportSize().width < 768) await page.getByTestId('mobile-topbar-menu').click();
    if (name) await page.getByText(name, { exact: true }).click();
    else await page.getByTestId('all-inboxes').click();
  };
  return { state, navigate, send: data => socket.send(JSON.stringify(data)), release: () => { state.held = false; state.releases.splice(0).forEach(resolve => resolve()); } };
}

test('warm account and unified navigation renders before the revalidation response', async ({ page, fixtureApi }) => {
  const { state, navigate, release } = await mailbox(page, fixtureApi);
  for (const account of fixtureApi.accounts) {
    await navigate(account.name);
    await expect(page.locator(`[data-msgid="nav-${account.id}"]`)).toBeVisible();
    await expect(page.locator('[data-msgid]')).toHaveCount(1);
  }
  state.held = true;
  state.revision = 2;
  try {
    for (const account of [null, ...fixtureApi.accounts]) {
      const before = state.requests.length;
      await navigate(account?.name);
      await expect.poll(() => state.requests.length).toBeGreaterThan(before);
      // The network is deliberately blocked: passing proves warm rendering does
      // not wait for HTTP, rather than imposing a flaky wall-clock speed limit.
      await expect(page.locator('[data-msgid]')).toHaveCount(account ? 1 : 3);
      await expect(page.locator(`[data-msgid="nav-${account?.id || 'account-gmail'}"]`)).toContainText('v1');
    }
  } finally { release(); }
  await expect(page.locator('[data-msgid="nav-account-fastmail"]')).toContainText('v2');
  await expect(page.locator('[data-msgid]')).toHaveCount(1);
});

test('a cold scope never displays another accounts rows while loading', async ({ page, fixtureApi }) => {
  const { state, navigate, release } = await mailbox(page, fixtureApi);
  state.held = true;
  try {
    await navigate('Outlook fixture');
    await expect.poll(() => state.requests.includes('account-outlook')).toBe(true);
    await expect(page.locator('[data-msgid]')).toHaveCount(0);
  } finally { release(); }
  await expect(page.locator('[data-msgid="nav-account-outlook"]')).toBeVisible();
});

test('failed warm revalidation keeps the scoped snapshot without replacing it with another account', async ({ page, fixtureApi }) => {
  const { navigate } = await mailbox(page, fixtureApi);
  await navigate('Gmail fixture');
  await expect(page.locator('[data-msgid]')).toHaveCount(1);
  await page.route(url => url.pathname === '/api/mail/messages' && !url.searchParams.has('accountId'), route => route.fulfill({ status: 503, json: { error: 'Temporary outage' } }));
  await navigate();
  await expect(page.locator('[data-msgid]')).toHaveCount(3);
  await expect(page.locator('[data-msgid="nav-account-outlook"]')).toContainText('v1');
});

for (const method of ['open', 'mark']) {
  test(`reading Gmail via ${method} keeps unrelated account navigation warm`, async ({ page, fixtureApi }) => {
    const { state, navigate, release } = await mailbox(page, fixtureApi);
    let reads = 0;
    const message = { id: 'nav-account-gmail', account_id: 'account-gmail', folder: 'INBOX', subject: 'Navigation Gmail fixture v1', from_email: 'sender@example.test', date: '2026-09-27T10:00:00Z' };
    await page.route(url => url.pathname === '/api/mail/messages/nav-account-gmail', route => route.fulfill({ json: { ...message, is_read: reads > 0 } }));
    await page.route('**/api/mail/messages/nav-account-gmail/body*', route => route.fulfill({ json: { html: '<p>Navigation body</p>', text: 'Navigation body' } }));
    await page.route('**/api/mail/messages/bulk-read', async route => {
      expect(route.request().postDataJSON()).toEqual({ ids: ['nav-account-gmail'], read: true });
      reads++;
      await route.fulfill({ json: { ok: true, updated: ['nav-account-gmail'] } });
    });
    for (const account of [fixtureApi.accounts[1], fixtureApi.accounts[2], fixtureApi.accounts[0]]) {
      await navigate(account.name);
      await expect(page.locator('[data-msgid]')).toHaveCount(1);
      await expect(page.locator(`[data-msgid="nav-${account.id}"]`)).toBeVisible();
    }
    const row = page.locator('[data-msgid="nav-account-gmail"]');
    if (method === 'open') {
      await row.click();
      await expect.poll(() => reads).toBeGreaterThan(0);
      if (page.viewportSize().width < 768) await page.getByTestId('message-pane-back').click();
    } else {
      if (page.viewportSize().width < 768) await row.getByRole('button', { name: /more/i }).click();
      else await row.click({ button: 'right' });
      await page.getByText(/mark as read/i).last().click();
      await expect.poll(() => reads).toBeGreaterThan(0);
    }
    state.held = true;
    try {
      for (const account of fixtureApi.accounts.slice(1)) {
        await navigate(account.name);
        await expect(page.locator(`[data-msgid="nav-${account.id}"]`)).toBeVisible();
      }
      await navigate();
      // The unified snapshot includes Gmail and must have been invalidated.
      await expect(page.locator('[data-msgid]')).toHaveCount(0);
    } finally { release(); }
    await expect(page.locator('[data-msgid]')).toHaveCount(3);
  });
}


for (const trigger of ['offscreen-flag', 'wake', 'two-minute-read']) {
  test(`${trigger} keeps unrelated visited inboxes visible before the next HTTP response`, async ({ page, fixtureApi }) => {
    if (trigger === 'two-minute-read') await page.addInitScript(() => {
      const originalNow = Date.now.bind(Date);
      window.__navigationClockOffset = 0;
      Date.now = () => originalNow() + window.__navigationClockOffset;
    });
    const { state, navigate, send, release } = await mailbox(page, fixtureApi);
    for (const account of fixtureApi.accounts) {
      await navigate(account.name);
      await expect(page.locator(`[data-msgid="nav-${account.id}"]`)).toBeVisible();
    }
    const before = state.requests.length;
    if (trigger === 'offscreen-flag') {
      // A real backend broadcasts changes for copies outside this loaded page.
      send({ type: 'message_flags', accountId: 'account-gmail', changes: [{ id: 'offscreen-gmail-copy', is_read: true }] });
      // Wait for the scoped coordinator to finish its counts request.
      await page.waitForResponse(response => new URL(response.url()).pathname === '/api/mail/unread-counts');
    } else if (trigger === 'two-minute-read') {
      await page.evaluate(() => { window.__navigationClockOffset = 120_000; });
    } else {
      const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/mail/messages');
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await refreshed;
    }
    state.held = true;
    try {
      await navigate('Outlook fixture');
      await expect.poll(() => state.requests.length).toBeGreaterThan(before);
      await expect(page.locator('[data-msgid="nav-account-outlook"]')).toBeVisible();
      await expect(page.locator('[data-msgid]')).toHaveCount(1);
    } finally { release(); }
  });
}


test('a foreign-account response cannot be shown or cached under Gmail, and recovery keeps mail unread', async ({ page, fixtureApi }) => {
  const { state, navigate, send } = await mailbox(page, fixtureApi);
  let broken = true;
  let reads = 0;
  const gmailRows = Array.from({ length: 6 }, (_, index) => ({ id: `gmail-new-${index}`, account_id: 'account-gmail', folder: 'INBOX',
    is_read: false, subject: `Unread Gmail ${index}`, from_email: 'sender@example.test', date: '2026-09-29T08:00:00Z' }));
  await page.route(url => url.pathname === '/api/mail/messages' && url.searchParams.get('accountId') === 'account-gmail', route => {
    reads++;
    const rows = broken ? [{ ...gmailRows[0], id: 'ovh-reply', account_id: 'account-fastmail', subject: 'OVH reply' }] : gmailRows;
    return route.fulfill({ json: { messages: rows, total: rows.length } });
  });
  await page.route('**/api/mail/unread-counts', route => route.fulfill({ json: {
    total: broken ? 0 : 6, byAccount: { 'account-gmail': broken ? 0 : 6 },
  } }));
  const writes = [];
  await page.route('**/api/mail/messages/bulk-read', route => {
    writes.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } });
  });
  await navigate('Gmail fixture');
  await expect.poll(() => reads).toBeGreaterThan(0);
  await expect(page.locator('[data-msgid]')).toHaveCount(0);
  // A different account's live event must not install its reply in Gmail.
  send({ type: 'new_messages', accountId: 'account-fastmail', folder: 'INBOX', messages: [], count: 1 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('[data-msgid="ovh-reply"]')).toHaveCount(0);
  broken = false;
  send({ type: 'mail_state_changed', accountId: 'account-gmail', folders: ['INBOX'] });
  await expect(page.locator('[data-msgid]')).toHaveCount(6);
  await expect(page.locator('[data-msgid="gmail-new-0"]')).toContainText('Unread Gmail 0');
  await expect(page.locator('[data-msgid] .unread-dot')).toHaveCount(6);
  await expect(page.locator('[data-account-id="account-gmail"]')).toHaveAttribute('data-unread-count', '6');
  // Filter remains evidence of the physical unread flags; no opening or mark-read occurred.
  const unreadOnly = page.getByRole('button', { name: 'Unread only', exact: true });
  if (await unreadOnly.isVisible()) await unreadOnly.click();
  await expect(page.locator('[data-msgid]')).toHaveCount(6);
  expect(writes).toEqual([]);
  expect(state.requests.includes('unified')).toBe(true);
});

test('a late old-account refresh cannot replace a newly selected Gmail list', async ({ page, fixtureApi }) => {
  const { state, navigate, release, send } = await mailbox(page, fixtureApi);
  await navigate('Outlook fixture');
  await expect(page.locator('[data-msgid="nav-account-outlook"]')).toBeVisible();
  const before = state.requests.length;
  state.held = true;
  try {
    send({ type: 'mail_state_changed', accountId: 'account-outlook', folders: ['INBOX'] });
    await expect.poll(() => state.requests.length).toBeGreaterThan(before);
    await navigate('Gmail fixture');
    await expect.poll(() => state.requests.at(-1)).toBe('account-gmail');
    await expect(page.locator('[data-msgid="nav-account-outlook"]')).toHaveCount(0);
  } finally { release(); }
  await expect(page.locator('[data-msgid]')).toHaveCount(1);
  await expect(page.locator('[data-msgid="nav-account-gmail"]')).toBeVisible();
  await expect(page.locator('[data-msgid="nav-account-outlook"]')).toHaveCount(0);
});
