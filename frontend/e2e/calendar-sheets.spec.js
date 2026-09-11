import { test, expect } from './fixtures.js';
import { setupV3, navigateModule } from './v3-fixtures.js';

// Verify the two calendar sheets read like the rest of the mobile UI: one title
// (the sheet header), a single padding layer, no duplicate primary action and
// touch targets that meet the app's 44px standard.
test('calendar sheets are consistent on mobile', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile-390', 'mobile only');
  await fixtureApi;
  await setupV3(page);
  await page.goto('/');
  await navigateModule(page, 'calendar');
  await page.waitForTimeout(700);

  // ── Day agenda sheet ───────────────────────────────────────────────────────
  await page.getByTestId('calendar-open-day').click();
  const daySheet = page.getByTestId('calendar-day-sheet');
  await expect(daySheet).toBeVisible();
  await page.waitForTimeout(500);
  // Exactly one visible title inside the sheet.
  const dayTitles = await daySheet.locator('h1:visible, h2:visible').allInnerTexts();
  console.log('[day sheet] visible titles:', JSON.stringify(dayTitles));
  expect(dayTitles).toEqual(['Agenda dnia']);
  // One padding layer: the body carries none, the agenda owns it.
  expect(await daySheet.locator('.ui-dialog-body').evaluate(el => getComputedStyle(el).padding)).toBe('0px');
  expect(await daySheet.getByTestId('calendar-day-agenda').evaluate(el => getComputedStyle(el).padding)).toBe('14px 16px 18px');
  const entryHeight = await daySheet.locator('.calendar-agenda-entry').first().evaluate(el => el.getBoundingClientRect().height);
  console.log('[day sheet] entry height:', entryHeight);
  expect(entryHeight).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // ── Calendar panel sheet ───────────────────────────────────────────────────
  await page.getByTestId('calendar-mobile-panel').click();
  const panel = page.getByTestId('calendar-mobile-dock');
  await expect(panel).toBeVisible();
  await page.waitForTimeout(500);
  const panelTitles = await panel.locator('h1:visible, h2:visible').allInnerTexts();
  console.log('[panel sheet] visible titles:', JSON.stringify(panelTitles));
  // Only the sheet header title; the rail's own "Kalendarz" heading is hidden and
  // the group labels stay as section headings.
  expect(panelTitles).not.toContain('Kalendarz');
  expect(panelTitles[0]).toBe('Panel kalendarzy');
  // No third "new event" affordance inside the sheet.
  expect(await panel.locator('.calendar-rail-create:visible').count()).toBe(0);
  // Mini-month day buttons are tappable on a phone.
  const dayButton = await panel.locator('[data-testid=calendar-mini-month] button').nth(3).evaluate(el => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  console.log('[panel sheet] mini-month day button:', JSON.stringify(dayButton));
  expect(dayButton.h).toBeGreaterThanOrEqual(40);
  expect(dayButton.w).toBeGreaterThanOrEqual(40);
});
