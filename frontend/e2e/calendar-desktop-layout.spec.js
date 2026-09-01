import { test, expect } from './fixtures.js';

test('desktop calendar grid fills the workspace next to its sidebar', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop calendar layout contract');
  await fixtureApi;
  await page.goto('/?list=0&reader=0');

  await page.getByTestId('calendar-nav-primary').click();
  const pageSurface = page.getByTestId('calendar-page');
  const grid = page.getByTestId('calendar-grid');
  await expect(grid).toBeVisible();

  const [pageBox, gridBox] = await Promise.all([pageSurface.boundingBox(), grid.boundingBox()]);
  expect(gridBox.width).toBeGreaterThan(pageBox.width * 0.6);
});