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