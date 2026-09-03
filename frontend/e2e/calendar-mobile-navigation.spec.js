import { test, expect } from './fixtures.js';

test('mobile calendar Back returns to the mail view', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-mobile-390', 'chromium-mobile'].includes(testInfo.project.name), 'mobile navigation contract');
  await fixtureApi;
  await page.goto('/?list=0&reader=0');

  await page.getByTestId('mobile-menu').click();
  await page.getByTestId('calendar-nav-mobile').click();
  await expect(page.getByTestId('mobile-calendar-page')).toBeVisible();

  await page.getByTestId('calendar-mobile-back').click();
  await expect(page.getByTestId('mobile-calendar-page')).not.toBeVisible();
  await expect(page.getByTestId('mobile-menu')).toBeVisible();
});

test('mobile calendar uses a bottom-right New event action and keeps its dialog inside the viewport', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-mobile-390', 'chromium-mobile'].includes(testInfo.project.name), 'mobile calendar layout contract');
  await fixtureApi;
  await page.goto('/?list=0&reader=0');

  await page.getByTestId('mobile-menu').click();
  await page.getByTestId('calendar-nav-mobile').click();
  const newEvent = page.getByTestId('calendar-mobile-new-event');
  await expect(newEvent).toBeVisible();
  const actionBox = await newEvent.boundingBox();
  expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(page.viewportSize().width);
  expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(page.viewportSize().height);

  await newEvent.click();
  const dialog = page.getByTestId('calendar-event-dialog');
  await expect(dialog).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(page.viewportSize().width);
});

test('mobile month calendar fits the application viewport without horizontal page or grid scrolling', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-mobile-390', 'chromium-mobile'].includes(testInfo.project.name), 'mobile calendar layout contract');
  await fixtureApi;
  await page.goto('/?list=0&reader=0');

  await page.getByTestId('mobile-menu').click();
  await page.getByTestId('calendar-nav-mobile').click();
  const grid = page.getByTestId('calendar-grid');
  await expect(grid).toBeVisible();

  const widths = await grid.evaluate((element) => ({
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    gridClientWidth: element.clientWidth,
    gridScrollWidth: element.scrollWidth,
  }));
  expect(widths.documentScrollWidth).toBe(widths.documentClientWidth);
  expect(widths.gridScrollWidth).toBeLessThanOrEqual(widths.gridClientWidth);
});

test('mobile manage-sources dialog keeps source controls inside the viewport', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-mobile-390', 'chromium-mobile'].includes(testInfo.project.name), 'mobile source dialog layout contract');
  await fixtureApi;
  let sources = [{ id: 'mobile-source', kind: 'ical_url', displayName: 'Mobile source with an intentionally long unbroken-name.example.test', url: 'https://calendar.example/mobile.ics', lastError: null, lastSyncAt: '2026-09-03T09:00:00.000Z' }];
  let syncCount = 0;
  let deleteCount = 0;
  let addCount = 0;
  await page.route('**/api/calendar/sources**', route => {
    const request = route.request();
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/sync')) {
      syncCount += 1;
      return route.fulfill({ json: { ok: true } });
    }
    if (request.method() === 'DELETE') {
      deleteCount += 1;
      sources = [];
      return route.fulfill({ json: { ok: true } });
    }
    if (request.method() === 'POST') {
      addCount += 1;
      return route.fulfill({ status: 201, json: { source: { id: 'added-source' }, sync: { ok: true } } });
    }
    return route.fulfill({ json: { sources } });
  });
  await page.goto('/?list=0&reader=0');
  await page.getByTestId('mobile-menu').click();
  await page.getByTestId('calendar-nav-mobile').click();
  await page.getByRole('button', { name: 'Kalendarze' }).click();
  await page.getByTestId('calendar-sidebar-manage-sources').click();
  const dialog = page.getByRole('dialog', { name: 'Zarządzaj źródłami' });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  for (const name of ['Zamknij', 'Dodaj źródło', 'Synchronizuj', 'Usuń']) {
    const control = dialog.getByRole('button', { name, exact: true });
    await expect(control).toBeVisible();
    const controlBox = await control.boundingBox();
    expect(controlBox.x).toBeGreaterThanOrEqual(0);
    expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(viewport.width);
  }
  const sourceRow = dialog.getByText('Mobile source with an intentionally long unbroken-name.example.test', { exact: true }).locator('..').locator('..');
  await expect(sourceRow).toBeVisible();
  expect(await sourceRow.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(await sourceRow.evaluate(element => element.clientWidth));
  await dialog.getByLabel('Nazwa', { exact: true }).fill('Added mobile source');
  await dialog.getByLabel('Adres URL').fill('https://calendar.example/added.ics');
  await dialog.getByRole('button', { name: 'Dodaj źródło', exact: true }).click();
  expect(addCount).toBe(1);
  await dialog.getByRole('button', { name: 'Synchronizuj', exact: true }).click();
  expect(syncCount).toBe(1);
  await dialog.getByRole('button', { name: 'Usuń', exact: true }).click();
  expect(deleteCount).toBe(1);
  await expect(dialog.getByText('Mobile source with an intentionally long unbroken-name.example.test', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Zamknij', exact: true }).click();
  await expect(dialog).toBeHidden();
});

test('mobile week calendar keeps its deliberate horizontal scroll inside the grid', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-mobile-390', 'chromium-mobile'].includes(testInfo.project.name), 'mobile calendar layout contract');
  await fixtureApi;
  await page.goto('/?list=0&reader=0');

  await page.getByTestId('mobile-menu').click();
  await page.getByTestId('calendar-nav-mobile').click();
  await page.getByTestId('calendar-view-week').click();
  const grid = page.getByTestId('calendar-grid');
  await expect(grid).toBeVisible();

  const widths = await grid.evaluate((element) => ({
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    gridClientWidth: element.clientWidth,
    gridScrollWidth: element.scrollWidth,
  }));
  expect(widths.documentScrollWidth).toBe(widths.documentClientWidth);
  expect(widths.gridScrollWidth).toBeGreaterThan(widths.gridClientWidth);
});

test('mobile week timeline keeps hourly geometry inside the calendar surface', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-mobile-390', 'chromium-mobile'].includes(testInfo.project.name), 'mobile time-grid contract');
  await fixtureApi;
  await page.route('**/api/calendar/events**', route => {
    const from = new Date(new URL(route.request().url()).searchParams.get('from'));
    const day = new Date(from); day.setDate(day.getDate() + 1);
    const date = day.toISOString().slice(0, 10);
    return route.fulfill({ json: { events: [{ id: 'mobile-timed', calendar_id: 'calendar-personal', summary: 'Mobile timed', starts_at: `${date}T13:00:00`, ends_at: `${date}T14:00:00`, all_day: false, source: 'local' }] } });
  });
  await page.goto('/?list=0&reader=0');
  await page.getByTestId('mobile-menu').click();
  await page.getByTestId('calendar-nav-mobile').click();
  await page.getByTestId('calendar-view-week').click();
  const grid = page.getByTestId('calendar-grid');
  await expect(grid.getByTestId('calendar-time-grid-scroll')).toBeVisible();
  await expect(grid.getByTestId('calendar-work-hours-boundary')).toHaveCount(7);
  const event = grid.getByRole('button', { name: /Mobile timed/ });
  await expect(event).toBeVisible();
  await expect(event.locator('..')).toHaveCSS('position', 'absolute');
  await page.screenshot({ path: 'artifacts/calendar-week-time-grid-mobile.png', fullPage: true });
});