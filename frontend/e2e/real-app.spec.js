import { selectCalendarView } from './navigation.js';
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
  await page.getByRole('button', { name: /New event|Nowe wydarzenie/ }).click();
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
