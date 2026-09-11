import { settleAnimations } from './navigation.js';
import { test, expect } from './fixtures.js';

const MOBILE_PROJECTS = new Set(['chromium-mobile-390', 'chromium-mobile']);

async function sharedPanelWidth(page) {
  return page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--list-width')));
}

async function dragHandle(page, testId, dx) {
  const handle = page.getByTestId(testId);
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  const y = box.y + Math.min(120, box.height / 2);
  const x = box.x + box.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 5 });
  await page.mouse.up();
}

test('every resizable side panel drives one shared width across Mail, Contacts and Calendar', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop resize contract');
  await fixtureApi;
  // Wide enough that the calendar keeps its day agenda beside the grid.
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('message-list-scroll')).toBeVisible();

  const mailList = page.locator('[data-ce-reader-enabled]');
  const initial = await sharedPanelWidth(page);
  await dragHandle(page, 'mail-list-resize', 70);
  const widened = await sharedPanelWidth(page);
  expect(widened).toBeCloseTo(initial + 70, 0);
  expect((await mailList.boundingBox()).width).toBeCloseTo(widened, 0);

  // Contacts adopts the width the mail list set...
  await page.getByTestId('contacts-nav-primary').click();
  const contactsList = page.getByTestId('contacts-desktop-list');
  await expect(contactsList).toBeVisible();
  expect((await contactsList.boundingBox()).width).toBeCloseTo(widened, 0);

  // ...and resizing it feeds the same shared value back to Mail.
  await dragHandle(page, 'contacts-list-resize', -30);
  const narrowed = await sharedPanelWidth(page);
  expect(narrowed).toBeCloseTo(widened - 30, 0);

  // Calendar rail and day agenda use the very same width.
  await page.getByTestId('calendar-nav-primary').click();
  const rail = page.getByTestId('calendar-sidebar');
  await expect(rail).toBeVisible();
  expect((await rail.boundingBox()).width).toBeCloseTo(narrowed, 0);
  const agenda = page.locator('aside.calendar-agenda');
  await expect(agenda).toBeVisible();
  expect((await agenda.boundingBox()).width).toBeCloseTo(narrowed, 0);

  await dragHandle(page, 'calendar-rail-resize', 40);
  const fromCalendar = await sharedPanelWidth(page);
  expect(fromCalendar).toBeCloseTo(narrowed + 40, 0);

  await page.getByText('Gmail fixture', { exact: true }).click();
  await expect(page.getByTestId('message-list-scroll')).toBeVisible();
  expect((await mailList.boundingBox()).width).toBeCloseTo(fromCalendar, 0);
});

test('the stacked mail layout renders the message list across the full width', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop mail layout contract');
  page.__preferencesOverride = { layout: 'vertical' };
  await fixtureApi;
  await page.goto('/');
  await expect(page.getByTestId('message-list-scroll')).toBeVisible();
  // Wait for the first row before measuring: an empty list has no row to size.
  await expect(page.locator('[data-msgid]').first()).toBeVisible();

  const geometry = await page.evaluate(() => {
    const shell = document.querySelector('[data-ce-reader-enabled]');
    const row = document.querySelector('[data-msgid]');
    const scroll = document.querySelector('[data-testid="message-list-scroll"]');
    const width = element => Math.round(element.getBoundingClientRect().width);
    return { shell: width(shell), row: width(row), scroll: width(scroll), viewport: window.innerWidth };
  });
  expect(geometry.row).toBe(geometry.shell);
  expect(geometry.scroll).toBe(geometry.shell);
  // The stacked list must span the pane it was given, not a fraction of it.
  expect(geometry.shell).toBeGreaterThan(geometry.viewport * 0.6);
  // The stacked layout keeps both panes in the same column, one above the other.
  const shellBox = await page.locator('[data-ce-reader-enabled]').boundingBox();
  const paneBox = await page.locator('[data-ce-reader-pane]').boundingBox();
  expect(paneBox.y).toBeGreaterThanOrEqual(shellBox.y + shellBox.height - 1);
  expect(paneBox.width).toBeCloseTo(shellBox.width, 0);
});

test('mobile calendar panel and day agenda share the same bottom sheet with one close control', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!MOBILE_PROJECTS.has(testInfo.project.name), 'mobile sheet presentation contract');
  await fixtureApi;
  await page.goto('/');
  const viewport = page.viewportSize();

  await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('calendar-nav-mobile').click();
  await expect(page.getByTestId('calendar-page')).toBeVisible();

  const expectBottomSheet = async (testId, expectContent) => {
    const sheet = page.getByTestId(testId);
    await expect(sheet).toHaveClass(/ui-sheet/);
    await settleAnimations(page);
    const box = await sheet.boundingBox();
    expect(box.x).toBeCloseTo(0, 0);
    expect(box.width).toBeCloseTo(viewport.width, 0);
    expect(box.y + box.height).toBeCloseTo(viewport.height, 0);
    expect(box.height).toBeLessThan(viewport.height);
    // Exactly one close affordance: the sheet header's ×. The panel used to add
    // its own "Zamknij" button next to it.
    await expect(sheet.getByRole('button', { name: 'Zamknij', exact: true })).toHaveCount(1);
    await expectContent(sheet);
    await sheet.getByRole('button', { name: 'Zamknij', exact: true }).click();
    await expect(sheet).toBeHidden();
  };

  await page.getByTestId('calendar-open-day').click();
  await expectBottomSheet('calendar-day-sheet', async sheet => {
    await expect(sheet.getByTestId('calendar-day-agenda')).toBeVisible();
  });

  await page.getByTestId('calendar-mobile-panel').click();
  await expectBottomSheet('calendar-mobile-dock', async sheet => {
    await expect(sheet.getByTestId('calendar-sidebar')).toBeVisible();
    await expect(sheet.getByTestId('calendar-mini-month')).toBeVisible();
  });
});
