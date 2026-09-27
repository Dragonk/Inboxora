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
  await page.routeWebSocket('**/ws*', () => {});
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
  return { state, navigate, release: () => { state.held = false; state.releases.splice(0).forEach(resolve => resolve()); } };
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
