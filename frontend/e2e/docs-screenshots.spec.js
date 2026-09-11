import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.js';
import { setupV3, navigateModule } from './v3-fixtures.js';
import { selectCalendarView } from './navigation.js';

// Documentation screenshot generator.
//
// These captures feed the README and the GitHub Wiki (`media/screenshots/`). They
// run against the real application with deterministic fixtures and English demo
// data, so the published images show the product rather than a mockup.
//
// The generator is opt-in and never runs as part of the regular browser gate:
//   cd frontend
//   DOCS_SCREENSHOTS=1 npx playwright test e2e/docs-screenshots.spec.js \
//     --project=chromium-desktop --project=chromium-mobile-390
//
// Every scenario is captured twice — `*-desktop.png` at 1440×900 and
// `*-mobile.png` at 390×844 — so both layouts can be documented. Committed images
// are reviewed assets; regenerate them deliberately and review the diff.

const OUTPUT_DIR = fileURLToPath(new URL('../../media/screenshots/', import.meta.url));
const enabled = Boolean(process.env.DOCS_SCREENSHOTS);

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  if (enabled) mkdirSync(OUTPUT_DIR, { recursive: true });
});

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(!enabled, 'documentation screenshots are generated on demand with DOCS_SCREENSHOTS=1');
  const desktop = testInfo.project.name === 'chromium-desktop';
  const phone = testInfo.project.name === 'chromium-mobile-390';
  test.skip(!desktop && !phone, 'desktop and 390px phone references only');
  page.__isDesktop = desktop;
  page.__languageOverride = 'en';
  if (desktop) await page.setViewportSize({ width: 1440, height: 900 });
});

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(
    animation => animation.effect?.getComputedTiming().endTime === Infinity || animation.playState !== 'running',
  ));
}

async function capture(page, name) {
  await settle(page);
  // Viewport-sized captures: documentation should show what a user actually
  // sees on screen, and they keep the committed image set small.
  await page.screenshot({ path: `${OUTPUT_DIR}${name}-${page.__isDesktop ? 'desktop' : 'mobile'}.png`, animations: 'disabled' });
}

// The conversation fixtures drive the real conversation engine: a five-message
// Gmail chain plus an Outlook and a generic IMAP conversation.
async function openMail(page, fixtureApi) {
  await fixtureApi;
  page.__conversationMatrix = '11';
  const listLoaded = page.waitForResponse(response => response.request().method() === 'GET' && response.ok() && new URL(response.url()).pathname === '/api/mail/messages');
  await page.goto('/?list=1&reader=1', { waitUntil: 'domcontentloaded' });
  await listLoaded;
  await expect(page.locator('[data-ce-reader-enabled]:visible').first()).toHaveAttribute('data-ce-reader-enabled', 'true');
  await expect(page.getByTestId('message-list-scroll')).toBeVisible();
}

function composeButton(page) {
  return (page.__isDesktop ? page.locator('.inboxora-sidebar') : page.getByTestId('mobile-topbar')).getByRole('button', { name: 'Compose', exact: true });
}

// Documentation images should read like a product page, so calendar and contact
// fixtures use English demo data instead of the Polish data the functional specs
// assert on. Registered after setupV3, so these handlers take precedence.
async function useEnglishDemoData(page) {
  const calendars = [
    { id: 'calendar-personal', name: 'Personal', color: '#35548a', source: 'local', read_only: false, owner_user_id: 'e2e-user' },
    { id: 'calendar-remote', name: 'Team · CalDAV', color: '#35793a', source: 'caldav', read_only: true },
  ];
  let events = [
    ...['Design review', 'Sprint planning', 'Customer call', 'One-to-one with Anna', 'Roadmap wrap-up'].map((summary, index) => ({
      id: `docs-event-${index}`, calendar_id: 'calendar-personal', calendar_color: '#35548a', source: 'local', read_only: false,
      summary, location: 'Northwind Studio', description: 'Agenda and notes are attached to the invitation.',
      starts_at: `2026-09-10T${String(8 + index).padStart(2, '0')}:00:00Z`, ends_at: `2026-09-10T${String(9 + index).padStart(2, '0')}:30:00Z`,
    })),
    { id: 'docs-remote', calendar_id: 'calendar-remote', calendar_color: '#35793a', source: 'caldav', read_only: true, summary: 'Team offsite', description: 'Pulled from the team CalDAV calendar.', all_day: true, starts_at: '2026-09-10T00:00:00Z', ends_at: '2026-09-12T00:00:00Z' },
    { id: 'docs-next-month', calendar_id: 'calendar-personal', source: 'local', summary: 'October roadmap', starts_at: '2026-10-01T09:00:00Z', ends_at: '2026-10-01T10:00:00Z' },
  ];
  const books = [{ id: 'book-work', name: 'Work', source: 'local', visible: true }, { id: 'book-private', name: 'Private', source: 'local', visible: true }];
  const contact = {
    id: 'v3-anna', display_name: 'Anna Novak', first_name: 'Anna', last_name: 'Novak',
    primary_email: 'anna.novak@example.test', address_book_id: 'book-work', organization: 'Northwind Studio',
    title: 'Product designer', role: 'Design systems', nickname: 'Ania', read_only: false,
    emails: [{ value: 'anna.novak@example.test', type: 'work', primary: true }, { value: 'anna.private@example.test', type: 'home' }],
    phones: [{ value: '+48 600 123 456', type: 'mobile' }],
    urls: [{ value: 'https://example.test', type: 'work' }],
    instantMessages: [{ value: 'anna:example.test', type: 'Matrix' }],
    addresses: [{ type: 'work', street: '12 Long Street', extended: 'Floor 2', locality: 'Warsaw', region: 'Mazovia', postalCode: '00-001', country: 'Poland' }],
    contactDates: [{ label: 'Birthday', value: '1990-09-10' }, { label: 'Anniversary', value: '2018-06-12' }],
    categories: ['Design', 'Team'], notes: 'Prefers calls in the morning. Owns the design system.',
    send_count: 12, last_sent: '2026-09-08T10:00:00Z',
  };

  await page.route('**/api/calendar/calendars', route => route.fulfill({ json: { calendars } }));
  await page.route('**/api/calendar/sources**', route => route.fulfill({ json: { sources: [] } }));
  await page.route('**/api/calendar/events**', route => {
    const url = new URL(route.request().url());
    const from = new Date(url.searchParams.get('from'));
    const to = new Date(url.searchParams.get('to'));
    return route.fulfill({ json: { events: events.filter(event => new Date(event.starts_at) < to && new Date(event.ends_at) > from) } });
  });
  await page.route('**/api/contacts**', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.includes('address-books')) return route.fulfill({ json: { addressBooks: books } });
    if (request.method() !== 'GET') return route.fulfill({ json: contact });
    if (url.pathname.endsWith('/v3-anna')) return route.fulfill({ json: contact });
    const query = (url.searchParams.get('q') || '').toLowerCase();
    const visible = JSON.stringify(contact).toLowerCase().includes(query);
    return route.fulfill({ json: { contacts: visible ? [contact] : [], total: visible ? 1 : 0 } });
  });
}

async function openCalendar(page, fixtureApi) {
  await setupV3(page);
  await useEnglishDemoData(page);
  await page.goto('/');
  await navigateModule(page, 'calendar');
}

async function openContacts(page, fixtureApi) {
  await setupV3(page);
  await useEnglishDemoData(page);
  await page.goto('/');
  await navigateModule(page, 'contacts');
  await page.getByRole('button', { name: 'Anna Novak', exact: true }).click();
}

async function openSettings(page) {
  if (!page.__isDesktop) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if (page.__isDesktop) await page.getByText('Settings', { exact: true }).first().click();
  else await page.getByTestId('mobile-settings').click();
  await expect(page.locator('.admin-panel')).toBeVisible();
}

async function openSettingsTab(page, name) {
  const button = page.locator('.admin-panel').getByRole('button', { name, exact: true }).first();
  await button.scrollIntoViewIfNeeded();
  await button.click();
}

test('documentation: mail list, threaded list, conversation reader and composer', async ({ page, fixtureApi }) => {
  await openMail(page, fixtureApi);
  await capture(page, 'mail-list');

  const parent = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');

  // Native threading keeps a conversation's parent row and its physical copies
  // together in the list.
  await parent.locator("button[aria-label*='(5)']").click();
  await expect(parent.locator('[data-thread-row-child]')).toHaveCount(5);
  await capture(page, 'mail-threaded-list');

  // Selecting one physical copy opens the conversation reader on that logical
  // message; the rest of the history stays collapsed until it is expanded.
  await parent.locator('[data-thread-row-child="conversation-gmail-copy-3"]').click();
  const reader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
  await expect(reader).toBeVisible();
  await expect(reader.locator('#logical-message-conversation-gmail-logical-3')).toHaveAttribute('data-conversation-message-state', 'expanded');
  await capture(page, 'mail-conversation');

  // A composer with real content documents the screen better than an empty form.
  await composeButton(page).click();
  await expect(page.getByRole('button', { name: /Send/ }).first()).toBeVisible();
  await page.getByPlaceholder('recipient@example.com').first().fill('anna.novak@example.test');
  await page.getByPlaceholder(/^(Add a subject|Subject)$/).first().fill('Quarterly planning — meeting agenda');
  const richBody = page.locator('.tiptap-compose [contenteditable="true"]').first();
  const body = [
    'Hi Anna,',
    '',
    'Here is the agenda for Thursday\'s planning session. I linked the roadmap draft in the previous thread, and the customer notes are attached to the invite.',
    '',
    '1. Where the last sprint landed',
    '2. Open questions from the design review',
    '3. Scope we want to freeze before the release',
    '',
    'Best,',
    'Kamil',
  ].join('\n');
  if (await richBody.count()) await richBody.fill(body);
  else await page.getByPlaceholder('Write your message…').first().fill(body);
  await capture(page, 'mail-composer');
});

test('documentation: calendar month, week and agenda', async ({ page, fixtureApi }) => {
  await openCalendar(page, fixtureApi);
  await expect(page.getByTestId('calendar-month-grid')).toBeVisible();
  await capture(page, 'calendar-month');
  if (!page.__isDesktop) await page.getByTestId('calendar-month-grid').getByRole('button', { name: /more/ }).first().click();
  await selectCalendarView(page, 'week');
  await expect(page.getByTestId('calendar-time-grid-scroll')).toBeVisible();
  await capture(page, 'calendar-week');
  await selectCalendarView(page, 'agenda');
  await expect(page.getByTestId('calendar-agenda-view')).toBeVisible();
  await capture(page, 'calendar-agenda');
});

test('documentation: contacts and the rich contact editor', async ({ page, fixtureApi }) => {
  await openContacts(page, fixtureApi);
  await expect(page.getByText('Northwind Studio', { exact: false }).first()).toBeVisible();
  await capture(page, 'contacts');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Nickname', { exact: true })).toBeVisible();
  await capture(page, 'contact-editor');
});

test('documentation: settings for appearance, DAV access and about', async ({ page, fixtureApi }) => {
  await page.route('**/api/dav-credentials', route => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { credentials: [
      { id: 'cred-phone', label: 'Pixel 7 · DAVx5', created_at: '2026-08-14T09:12:00Z', last_used_at: '2026-09-11T07:41:00Z' },
      { id: 'cred-laptop', label: 'Thunderbird (laptop)', created_at: '2026-07-02T18:30:00Z', last_used_at: null },
    ] } });
  });
  await page.route('**/api/version', route => route.fulfill({ json: { version: '4.0.0', sha: '4f4a2c19d5c8f0b7a1e34a9c6d2b8ef0173c5a64' } }));
  await openMail(page, fixtureApi);

  await openSettings(page);
  await openSettingsTab(page, 'Appearance');
  await capture(page, 'settings-appearance');

  await openSettingsTab(page, 'DAV access');
  await expect(page.getByText('Pixel 7 · DAVx5', { exact: true })).toBeVisible();
  await capture(page, 'settings-dav-access');

  await openSettingsTab(page, 'About');
  await expect(page.getByText('4.0.0', { exact: true })).toBeVisible();
  await capture(page, 'settings-about');
});
