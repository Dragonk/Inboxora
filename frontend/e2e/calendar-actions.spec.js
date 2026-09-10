import { test, expect } from './fixtures.js';
import { setupV3, navigateModule } from './v3-fixtures.js';
import { selectCalendarView } from './navigation.js';

test('floating action is contextual and disappears for bottom navigation in every module', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile-390', 'phone actions');
  await fixtureApi; await setupV3(page); await page.goto('/');
  const action = page.locator('[data-testid="mobile-floating-action"]:visible');
  await expect(action).toHaveCount(1);
  const header = page.getByTestId('mobile-topbar');
  await expect(page.getByTestId('mobile-navigation')).toHaveCount(0);
  expect((await header.boundingBox()).height).toBeLessThanOrEqual(54);
  await expect(header.locator('h1')).not.toBeEmpty();
  const unread = header.getByRole('button', { name: 'Tylko nieprzeczytane', exact: true });
  await unread.click();
  await expect(header.getByRole('button', { name: 'Pokaż wszystkie', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await header.getByRole('button', { name: 'Pokaż wszystkie', exact: true }).click();
  await header.getByRole('button', { name: 'Zaznacz wiadomości', exact: true }).click();
  await expect(header.getByRole('button', { name: 'Anuluj', exact: true })).toBeVisible();
  await page.goBack();
  await expect(header.getByRole('button', { name: 'Zaznacz wiadomości', exact: true })).toBeVisible();
  await action.click();
  await expect(page.getByPlaceholder('Dodaj temat', { exact: true })).toBeVisible();
  await page.goBack();
  await navigateModule(page, 'contacts');
  await action.click();
  await expect(page.getByRole('button', { name: /^Zapisz/ })).toBeVisible();
  await page.goBack();
  await navigateModule(page, 'calendar');
  await action.click();
  await expect(page.getByTestId('calendar-event-dialog')).toBeVisible();
  await page.goBack();
  await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  await page.getByTestId('mobile-settings').click();
  await page.locator('.admin-tab').filter({ hasText: /^Wygląd$/ }).click();
  await page.locator('.admin-subtab').filter({ hasText: /^Układ$/ }).click();
  await page.getByTestId('mobile-navigation-position-setting').getByRole('button', { name: 'Na dole' }).click();
  await page.goBack();
  for (const module of ['contacts', 'calendar']) {
    await navigateModule(page, module);
    await expect(action).toHaveCount(0);
  }
  await page.goBack();
  await expect(page.getByTestId('message-list-scroll')).toBeVisible();
  await expect(action).toHaveCount(0);
});

test('all calendar types share appearance controls and contact event labels are translated', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-desktop', 'chromium-mobile-390'].includes(testInfo.project.name), 'calendar display metadata');
  await fixtureApi; await setupV3(page);
  const calendars = [
    { id: 'local', name: 'Osobisty', source: 'local', owner_user_id: 'e2e-user', read_only: false, color: '#35558a' },
    { id: 'remote', name: 'Praca', source: 'ical_url', owner_user_id: 'e2e-user', read_only: true, color: '#35558a' },
    { id: 'contacts-birthdays', name: 'Contact dates', source: 'contacts', read_only: true, color: '#e879f9' },
  ];
  const updates = [];
  await page.route('**/api/calendar/calendars**', route => {
    if (route.request().method() === 'PATCH') {
      const id = new URL(route.request().url()).pathname.split('/').at(-1);
      const body = route.request().postDataJSON(); updates.push({ id, ...body });
      const calendar = calendars.find(c => c.id === id); Object.assign(calendar, body, { custom_name: true });
      return route.fulfill({ json: { calendar } });
    }
    return route.fulfill({ json: { calendars } });
  });
  await page.route('**/api/calendar/events**', route => route.fulfill({ json: { events: ['Birthday', 'Anniversary', 'Name day', 'Ślub: cywilny'].map((label, i) => ({
    id: `date-${i}`, source: 'contacts', calendar_id: 'contacts-birthdays', summary: `${label}: Anna`, contact_date_label: label, contact_name: 'Anna', all_day: true, read_only: true, starts_at: '2026-09-10T00:00:00Z', ends_at: '2026-09-11T00:00:00Z',
  })) } }));
  await page.goto('/'); await navigateModule(page, 'calendar');
  await selectCalendarView(page, 'agenda');
  for (const label of ['Urodziny', 'Rocznica', 'Imieniny', 'Ślub: cywilny']) await expect(page.getByText(`${label}: Anna`, { exact: true }).first()).toBeVisible();
  if (page.viewportSize().width < 768) await page.getByTestId('calendar-mobile-panel').click();
  for (const [index, name] of ['Osobisty', 'Praca', 'Daty kontaktów'].entries()) {
    const rail = page.getByTestId('calendar-sidebar').filter({ visible: true });
    await rail.getByRole('button', { name: `Akcje dla ${name}`, exact: true }).click();
    await rail.getByRole('menuitem', { name: 'Zmień kolor' }).click();
    const dialog = page.getByTestId('calendar-appearance-dialog');
    await dialog.getByLabel('Nazwa kalendarza', { exact: true }).fill(`Nowy ${name}`);
    await dialog.getByRole('button', { name: 'Zmień kolor #35793a', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath(`calendar-appearance-${index}.png`) });
    await dialog.getByRole('button', { name: 'Zapisz', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(rail.getByRole('button', { name: `Akcje dla Nowy ${name}`, exact: true })).toBeVisible();
  }
  expect(updates.map(item => item.color)).toEqual(['#35793a', '#35793a', '#35793a']);
  expect(calendars[1].read_only).toBe(true);
});

test('long legacy sync warnings have a localized summary and collapsed diagnostics', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile-390', 'mobile sync status');
  await fixtureApi; await setupV3(page);
  await page.route('**/api/calendar/sources**', route => route.fulfill({ json: { sources: [{ id: 'work', displayName: 'Praca', kind: 'ical_url', lastError: Array.from({ length: 50 }, (_, i) => `synthetic-${i}: unsupported or malformed VEVENT`).join('; ') }] } }));
  await page.goto('/'); await navigateModule(page, 'calendar');
  await page.getByTestId('calendar-mobile-panel').click();
  await page.getByRole('button', { name: 'Zarządzaj źródłami' }).click();
  const row = page.getByTestId('calendar-source-row');
  await expect(row.getByRole('status')).toContainText('Pominięte wydarzenia: 50');
  await expect(row.locator('pre')).not.toBeVisible();
  expect((await row.boundingBox()).height).toBeLessThan(220);
  await row.getByText('Szczegóły diagnostyczne').click();
  await expect(row.locator('pre')).toContainText('synthetic-0');
  await expect(row.locator('pre')).not.toContainText('synthetic-49');
  await page.screenshot({ path: testInfo.outputPath('calendar-sync-status.png') });
});
