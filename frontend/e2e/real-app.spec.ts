import { selectCalendarView } from './navigation.ts';
import { test, expect } from './real-app-fixtures.ts';

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
    // The list shows five logical messages even though the native provider exposes
    // six actionable physical copies (the latest mail also exists in All-Mail).
    await expect(goldenThread.locator('[data-thread-row-child]')).toHaveCount(5);
    await goldenThread.locator('[data-thread-row-child]').first().click();
    const reader = page.locator('section[data-conversation-id]:visible');
    await expect(reader).toHaveCount(1);
    // Five logical messages have six independently addressable physical copies.
    await expect(reader.locator('[data-logical-message-id]')).toHaveCount(6);
    const identities = await reader.locator('[data-logical-message-id]').evaluateAll(cards => cards.map(card => ({
      logical: card.getAttribute('data-logical-message-id'), physical: card.id,
    })));
    expect(new Set(identities.map(card => card.logical)).size).toBe(5);
    expect(new Set(identities.map(card => card.physical)).size).toBe(6);
    await expect(reader.locator('iframe').first().contentFrame().getByText(/Fixture body (?:1|2|3|4|5)/, { exact: false })).toBeVisible();
  });
});

test('V3 contact editing persists rich fields through the live API', async ({ authenticatedPage: page }, testInfo) => {
  const headers = { 'X-Requested-With': 'MailFlow' };
  const name = `V3 contact ${testInfo.project.name}`;
  const response = await page.request.post('/api/contacts', { headers, data: {
    displayName: name, nickname: 'Before', organization: 'Test studio',
    emails: [{ value: 'v3@example.test', type: 'work', primary: true }],
    phones: [{ value: '+48 600 123 456', type: 'mobile' }],
    categories: ['V3'], addresses: [{ type: 'work', street: 'Testowa 12', locality: 'Warszawa', country: 'Polska' }],
  } });
  expect(response.ok()).toBe(true);
  const contact = await response.json();
  try {
    if (page.viewportSize().width < 768) await page.getByTestId('mobile-topbar-menu').click();
    await page.getByTestId(`contacts-nav-${page.viewportSize().width < 768 ? 'mobile' : 'primary'}`).click();
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('button', { name: /^(Edit|Edytuj)$/ }).click();
    await page.getByLabel(/^(Nickname|Pseudonim)$/).fill('After V3');
    await page.getByRole('button', { name: /^(Save|Zapisz)/ }).click();
    await expect(page.getByText('(After V3)', { exact: false })).toBeVisible();
    const saved = await (await page.request.get(`/api/contacts/${contact.id}`)).json();
    expect(saved.nickname).toBe('After V3');
    expect(saved.phones).toEqual(contact.phones);
    expect(saved.addresses).toEqual(contact.addresses);
    expect(saved.emails).toEqual(contact.emails);
  } finally {
    expect((await page.request.delete(`/api/contacts/${contact.id}`, { headers })).ok()).toBe(true);
  }
});

test('V3 calendar creates, reloads and deletes an event against the live API', async ({ authenticatedPage: page }, testInfo) => {
  const headers = { 'X-Requested-With': 'MailFlow' };
  const name = `V3 event ${testInfo.project.name}`;
  const calendarResponse = await page.request.post('/api/calendar/calendars', { headers, data: { name, color: '#35548a' } });
  expect(calendarResponse.ok()).toBe(true);
  const { calendar } = await calendarResponse.json();
  const navigate = async () => {
    if (page.viewportSize().width < 768) await page.getByTestId('mobile-topbar-menu').click();
    await page.getByTestId(`calendar-nav-${page.viewportSize().width < 768 ? 'mobile' : 'primary'}`).click();
  };
  try {
  await navigate();
  // The mobile header action and the floating action share the accessible name
  // "New event", so pick the affordance by its explicit test id per viewport rather
  // than matching by name (which resolved to two elements).
  const newEvent = page.viewportSize().width < 768
    ? page.getByTestId('calendar-header-new')
    : page.getByTestId('calendar-rail-new-event');
  await newEvent.click();
  const editor = page.getByTestId('calendar-event-dialog');
  await editor.getByRole('textbox').first().fill(name);
  const savedResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/calendar/events');
  await editor.getByRole('button', { name: /^(Save|Zapisz)/ }).click();
  const response = await savedResponse;
  expect(response.ok()).toBe(true);
  const { event } = await response.json();
  try {
    await expect(editor).toBeHidden();
    await page.reload(); await navigate();
    await selectCalendarView(page, 'agenda');
    await page.getByTestId('calendar-agenda-view').getByRole('button', { name: new RegExp(name) }).click();
    // Every event opens the read-only preview first (its description renders like a
    // message body); the editor is one step further, behind Edit.
    const preview = page.getByTestId('calendar-event-preview');
    await expect(preview).toContainText(name);
    await preview.getByTestId('calendar-preview-edit').click();
    await expect(editor.getByRole('textbox').first()).toHaveValue(name);
    page.once('dialog', dialog => dialog.accept());
    await editor.getByRole('button', { name: /^(Delete|Usuń)$/ }).click();
    await expect(editor).toBeHidden();
    await expect(page.getByTestId('calendar-agenda-view')).not.toContainText(name);
  } finally {
    const cleanup = await page.request.delete(`/api/calendar/events/${event.id}?calendarId=${event.calendar_id}`, { headers });
    expect(cleanup.ok() || cleanup.status() === 404).toBe(true);
  }
  } finally {
    const cleanup = await page.request.delete(`/api/calendar/calendars/${calendar.id}`, { headers, data: { confirmName: name } });
    expect(cleanup.ok()).toBe(true);
  }
});

// Exercise the actual WorkerNavigator methods. API stubs cannot catch a native
// renderer termination when the browser has no service-worker BadgeService.
test('native service-worker badges keep the real app alive across reload', async ({ authenticatedPage: page }) => {
  const crashes: string[] = [];
  page.on('crash', () => crashes.push('renderer crashed'));
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  const worker = page.context().serviceWorkers()
    .find(candidate => new URL(candidate.url()).pathname === '/sw.js');
  expect(worker, 'the application service worker must be running').toBeDefined();
  if (!worker) throw new Error('Application service worker is missing');

  await expect.poll(() => worker.evaluate(() =>
    typeof (globalThis as unknown as { inboxoraRefreshBadge?: unknown }).inboxoraRefreshBadge,
  )).toBe('function');

  const completed = await worker.evaluate(async () => {
    const scope = globalThis as unknown as {
      navigator: { setAppBadge?: (count: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
      inboxoraRefreshBadge: () => Promise<unknown>;
    };
    if (typeof scope.navigator.setAppBadge !== 'function' || typeof scope.navigator.clearAppBadge !== 'function') {
      throw new Error('Real browser must expose native service-worker Badging API');
    }
    await scope.navigator.setAppBadge(7);
    await scope.navigator.clearAppBadge();
    // Restore the real authoritative count using the application's worker code.
    await scope.inboxoraRefreshBadge();
    // A resolved JS promise can precede a bad Mojo-message renderer termination.
    await new Promise(resolve => setTimeout(resolve, 250));
    return 'native calls completed';
  });
  expect(completed).toBe('native calls completed');
  await expect(page.getByText('Golden conversation thread', { exact: true }).first()).toBeVisible();
  expect(crashes).toEqual([]);

  await page.reload();
  await expect(page.getByText('Golden conversation thread', { exact: true }).first()).toBeVisible();
  expect(crashes).toEqual([]);
});


// Hit the production middleware, not a browser route mock. Empty recipients
// prove attachment parsing reaches validation without queuing or delivering mail.
test('mail merge accepts attachment requests beyond the global JSON cap', async ({ request }, testInfo) => {
  const headers = { 'X-Requested-With': 'MailFlow', 'X-Idempotency-Key': `merge-body-window-${testInfo.project.name}` };
  const login = await request.post('/api/auth/login', { headers, data: {
    username: process.env.PLAYWRIGHT_USERNAME || 'playwright@example.test',
    password: process.env.PLAYWRIGHT_PASSWORD || 'PlaywrightPassword123!',
  } });
  expect(login.ok()).toBe(true);
  const before = await request.get('/api/mail/scheduled');
  expect(before.ok()).toBe(true);
  const queued = await before.json();
  const data = { message: {
    accountId: '11111111-1111-4111-8111-111111111111', to: [], cc: [], bcc: [],
    subject: 'Attachment parser regression', body: 'No delivery', bodyIsHtml: false,
    attachments: [{ filename: 'large.bin', contentType: 'application/octet-stream',
      content: Buffer.alloc(900 * 1024, 0xa5).toString('base64') }],
  } };
  expect(Buffer.byteLength(JSON.stringify(data))).toBeGreaterThan(1024 * 1024);
  const response = await request.post('/api/mail/merge', { headers, data });
  expect(response.status()).toBe(400);
  expect(await response.json()).toMatchObject({ code: 'SCHEDULE_INVALID', error: 'At least one recipient is required' });
  const after = await request.get('/api/mail/scheduled');
  expect(after.ok()).toBe(true);
  expect(await after.json()).toEqual(queued);
});
