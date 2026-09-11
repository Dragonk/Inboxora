import { selectCalendarView, openContactBooks, settleAnimations } from './navigation.js';
import { test, expect } from './fixtures.js';
import { setupV3, navigateModule, richContact } from './v3-fixtures.js';

test.beforeEach(async ({ page, fixtureApi }, testInfo) => {
  await fixtureApi;
  if (testInfo.project.name === 'chromium-desktop') await page.setViewportSize({ width: 1440, height: 900 });
});

test('V3 calendar selects a day, reveals overflow, filters both agendas and shows imported details', async ({ page }) => {
  const calls = await setupV3(page);
  await page.goto('/');
  await navigateModule(page, 'calendar');
  const grid = page.getByTestId('calendar-month-grid');
  await expect(grid).toBeVisible();
  await expect.poll(() => calls.events.length).toBeGreaterThan(0);
  expect(calls.events.at(-1)).toEqual({ from: '2026-08-31T00:00:00.000Z', to: '2026-10-12T00:00:00.000Z' });
  await grid.getByRole('button', { name: /więcej/ }).click();
  const agenda = page.getByTestId('calendar-day-agenda');
  await expect(agenda.getByRole('button')).toHaveCount(6);
  await agenda.getByRole('button', { name: /Wyjazd zespołu/ }).click();
  await expect(page.getByTestId('calendar-event-preview').getByRole('button', { name: 'Zamknij', exact: true })).toBeFocused();
  const preview = page.getByTestId('calendar-event-preview');
  // The imported description renders through the sanitized body iframe mail uses,
  // so the copy is asserted inside that frame rather than on the dialog's DOM text.
  await expect(preview.getByTestId('calendar-event-description-body').frameLocator('iframe').locator('body')).toContainText('Wydarzenie ze źródła CalDAV.');
  await expect(preview.getByRole('button', { name: /Zapisz|Usuń/ })).toHaveCount(0);
  await preview.getByRole('button', { name: 'Zamknij', exact: true }).click();
  if (page.viewportSize().width <= 1100) await page.getByRole('dialog', { name: 'Agenda dnia', exact: true }).getByRole('button', { name: 'Zamknij', exact: true }).click();
  await selectCalendarView(page, 'agenda');
  await expect(page.getByTestId('calendar-agenda-view').getByRole('button', { name: /Wyjazd zespołu/ })).toHaveCount(2);
  await expect(page.getByTestId('calendar-agenda-view')).not.toContainText('Plan października');
  if (page.viewportSize().width < 768) await page.getByTestId('calendar-mobile-panel').click();
  await page.getByTestId('calendar-sidebar').getByRole('checkbox', { name: /Zespół/ }).uncheck();
  if (page.viewportSize().width < 768) await page.getByTestId('calendar-mobile-dock').getByRole('button', { name: 'Zamknij', exact: true }).click();
  await expect(page.getByTestId('calendar-agenda-view')).not.toContainText('Wyjazd zespołu');
});

test('V3 contact edit retains rich fields and a selected email opens the real composer', async ({ page }) => {
  const calls = await setupV3(page);
  await page.goto('/');
  await navigateModule(page, 'contacts');
  await page.getByRole('button', { name: 'Anna Kowalska', exact: true }).click();
  await expect(page.getByText('Piętro 2', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Edytuj', exact: true }).click();
  await page.getByLabel('Pseudonim', { exact: true }).fill('Anna V3');
  await page.getByRole('button', { name: /^Zapisz/ }).click();
  await expect.poll(() => calls.contacts.length).toBe(1);
  expect(calls.contacts[0]).toMatchObject({ nickname: 'Anna V3', emails: richContact.emails, phones: richContact.phones, addresses: richContact.addresses, contactDates: richContact.contactDates, urls: richContact.urls, instantMessages: richContact.instantMessages, categories: richContact.categories });
  await expect(page.getByText('(Anna V3)', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'anna.private@example.test', exact: true }).click();
  await expect(page.getByText('anna.private@example.test', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: /Wyślij/ }).first()).toBeVisible();
});

test('V3 desktop panel geometry and independent pane scrolling follow the mockup', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop geometry');
  await setupV3(page); await page.goto('/'); await navigateModule(page, 'calendar');
  const sidebar = await page.getByTestId('calendar-sidebar').boundingBox();
  const surface = await page.getByTestId('calendar-page').boundingBox();
  const agenda = await page.locator('aside.calendar-agenda').boundingBox();
  // The rail carries the shared list column (Mail/Contacts/Calendar stay in step)
  // while the day agenda keeps its own independently persisted width.
  const sharedWidth = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--list-width')));
  const agendaWidth = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--agenda-width')));
  expect(sharedWidth).toBeGreaterThan(0);
  expect(agendaWidth).toBeGreaterThan(0);
  expect(sidebar.width).toBeCloseTo(sharedWidth, 0);
  expect(agenda.width).toBeCloseTo(agendaWidth, 0);
  expect(sidebar.y).toBe(surface.y); expect(sidebar.x).toBe(surface.x);
  expect(agenda.x + agenda.width).toBe(1440);
  const body = await page.locator('.calendar-body').boundingBox();
  expect(body.y + body.height).toBe(900);
  await selectCalendarView(page, 'week');
  const scroll = await page.getByTestId('calendar-time-grid-scroll').boundingBox();
  expect(scroll.height).toBeCloseTo(body.height, 0);
});

test('V3 visual references for the suite', async ({ page }, testInfo) => {
  await setupV3(page); await page.goto('/');
  await navigateModule(page, 'calendar');
  const screenshot = async name => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.effect?.getComputedTiming().endTime === Infinity || animation.playState !== 'running'));
    await expect(page).toHaveScreenshot(`${name}.png`, { animations: 'disabled', maxDiffPixelRatio: 0.002 });
  };
  await screenshot('calendar-month');
  await selectCalendarView(page, 'week');
  await screenshot('calendar-week');
  await selectCalendarView(page, 'agenda');
  await screenshot('calendar-agenda');
  await navigateModule(page, 'contacts');
  await page.getByRole('button', { name: 'Anna Kowalska', exact: true }).click();
  await screenshot('contact-detail');
  await page.getByRole('button', { name: 'Edytuj', exact: true }).click();
  await screenshot('contact-form');
  // Attach project geometry alongside image diffs for diagnosing tablet/native failures.
  await testInfo.attach('viewport', { body: JSON.stringify(page.viewportSize()), contentType: 'application/json' });
});

test('V3 retains calendar preferences, filters and useful geometry at increased UI scale', async ({ page }) => {
  await setupV3(page);
  page.__preferencesOverride = { fontSize: '125', calendarWeekStartsOn: 0, calendarWorkDays: [0, 2, 4], calendarWorkHoursStart: '07:30', calendarWorkHoursEnd: '15:30', mobileNavigationPosition: 'bottom' };
  await page.goto('/'); await navigateModule(page, 'calendar');
  await expect(page.getByTestId('calendar-grid').getByTestId('calendar-weekday').first()).toHaveText('niedziela');
  const toolbar = page.locator('.calendar-header');
  const toolbarBox = await toolbar.boundingBox();
  expect(toolbarBox.x).toBeGreaterThanOrEqual(0);
  expect(toolbarBox.x + toolbarBox.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
  if (page.viewportSize().width < 768) {
    const fab = await page.getByTestId('calendar-header-new').boundingBox();
    expect(fab.y).toBeGreaterThan(toolbarBox.y + toolbarBox.height);
    await expect(page.getByTestId('mobile-topbar')).toHaveAttribute('data-position', 'bottom');
  }
  await selectCalendarView(page, 'workweek');
  await expect(page.getByTestId('calendar-work-hours-boundary')).toHaveCount(3);
  const scroll = page.getByTestId('calendar-time-grid-scroll');
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(330);
  await page.getByTestId('calendar-open-day').click();
  const drawer = page.getByRole('dialog', { name: 'Agenda dnia', exact: true });
  await expect(drawer).toBeVisible();
  // The panel is a bottom sheet on narrow screens; measure it after the slide-up
  // settles so the transform cannot place it below the viewport mid-animation.
  await settleAnimations(page);
  const box = await drawer.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize().height + 1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('calendar-open-day')).toBeFocused();
});

test('V3 calendar retries failed saves without closing the editor or losing entered fields', async ({ page }) => {
  const calls = await setupV3(page);
  let fail = true;
  await page.route('**/api/calendar/events', route => {
    if (route.request().method() === 'POST' && fail) { fail = false; return route.fulfill({ status: 503, json: { error: 'Spróbuj ponownie' } }); }
    return route.fallback();
  });
  await page.goto('/'); await navigateModule(page, 'calendar');
  if (page.viewportSize().width < 768) await page.getByTestId('calendar-header-new').click();
  else await page.getByTestId('calendar-sidebar').getByRole('button', { name: /Nowe wydarzenie/ }).click();
  const editor = page.getByTestId('calendar-event-dialog');
  const title = editor.getByRole('textbox').first();
  await expect(title).toBeFocused();
  await title.fill('Spotkanie V3');
  await editor.getByRole('button', { name: /^Zapisz/ }).click();
  await expect(editor.getByRole('alert')).toHaveText('Spróbuj ponownie');
  await expect(title).toHaveValue('Spotkanie V3');
  await editor.getByRole('button', { name: /^Zapisz/ }).click();
  await expect(editor).toBeHidden();
  await expect.poll(() => calls.saves.length).toBe(1);
  expect(calls.saves[0].summary).toBe('Spotkanie V3');
});

test('V3 visual references for mail, composer, settings and login', async ({ page }) => {
  await setupV3(page); await page.goto('/');
  const screenshot = async name => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.effect?.getComputedTiming().endTime === Infinity || animation.playState !== 'running'));
    await expect(page).toHaveScreenshot(`${name}.png`, { animations: 'disabled', maxDiffPixelRatio: 0.002 });
  };
  await expect(page.getByTestId('message-list-scroll')).toBeVisible();
  await screenshot('mail-list');
  await (page.viewportSize().width < 768 ? page.getByTestId('mobile-topbar') : page.locator('.inboxora-sidebar')).getByRole('button', { name: 'Napisz', exact: true }).click();
  await expect(page.getByRole('button', { name: /Wyślij/ }).first()).toBeVisible();
  await screenshot('composer');
  await page.reload();
  if (page.viewportSize().width < 768) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if (page.viewportSize().width < 768) await page.getByTestId('mobile-settings').click();
  else await page.getByText('Ustawienia', { exact: true }).first().click();
  await page.getByText('Wygląd', { exact: true }).click();
  await page.locator('.admin-tab-active').evaluate(tab => tab.scrollIntoView({ inline: 'center', block: 'center', behavior: 'instant' }));
  await screenshot('settings');
  await page.route('**/api/auth/me', route => route.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
  await page.goto('/login');
  await expect(page.getByRole('button', { name: /Zaloguj/ })).toBeVisible();
  await screenshot('login');
});

test('V3 address-book tabs preserve search and reject a late response from the previous book', async ({ page }) => {
  await setupV3(page);
  let release;
  const requested = new Promise(resolve => { release = resolve; });
  let delayedRoute;
  let privateQuery;
  await page.route('**/api/contacts?**', route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('q') === 'anna' && !url.searchParams.get('addressBookId')) {
      delayedRoute = route; release(); return;
    }
    if (url.searchParams.get('addressBookId') === 'book-private') privateQuery = url.searchParams.get('q');
    return route.fallback();
  });
  await page.goto('/'); await navigateModule(page, 'contacts');
  await page.getByRole('searchbox').fill('anna');
  await requested;
  await openContactBooks(page);
  await page.getByRole('button', { name: 'Prywatna', exact: true }).click();
  await expect.poll(() => privateQuery).toBe('anna');
  await expect(page.getByRole('button', { name: 'Anna Kowalska', exact: true })).toHaveCount(0);
  const oldResponse = page.waitForResponse(response => new URL(response.url()).searchParams.get('q') === 'anna' && !new URL(response.url()).searchParams.has('addressBookId'));
  await delayedRoute.fulfill({ json: { contacts: [richContact], total: 1 } });
  await oldResponse;
  await expect(page.getByRole('button', { name: 'Anna Kowalska', exact: true })).toHaveCount(0);
  await openContactBooks(page);
  await page.getByRole('button', { name: 'Firmowa', exact: true }).click();
  await expect(page.getByRole('searchbox')).toHaveValue('anna');
  await expect(page.getByRole('button', { name: 'Anna Kowalska', exact: true })).toBeVisible();
  await openContactBooks(page);
  await page.locator('.contacts-book-menu summary').click();
  await expect(page.locator('.contacts-book-actions a')).toHaveCount(3);
  await expect(page.locator('.contacts-book-actions a').last()).toHaveAttribute('href', /vcard/);
});
