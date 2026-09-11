import { test, expect } from './fixtures.js';

// A week grid on a phone is wider than the screen, so two things have to hold:
//
//   1. it opens on today instead of on Monday, so the user does not have to swipe to
//      find the day they came for;
//   2. it pans in both directions from ONE scroll container — splitting the axes across
//      nested scrollers made every sideways swipe hand off between containers, which
//      read as the grid catching mid-gesture.
//
// 9 September 2026 is a Wednesday, which sits mid-week and is therefore centred without
// hitting either clamp; a Monday or Sunday would legitimately pin to an edge.
const TODAY = new Date('2026-09-09T10:15:00Z');
const VIEW_STORAGE_KEY = 'mailflow_calendar_view';

async function openCalendarOnPhone(page, view) {
  await page.clock.setFixedTime(TODAY);
  await page.addInitScript(([key, value]) => {
    try { localStorage.setItem(key, value); } catch { /* blocked storage still opens */ }
  }, [VIEW_STORAGE_KEY, view]);
  await page.goto('/?list=0&reader=0');
  await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('calendar-nav-mobile').click();
  const scroller = page.getByTestId('calendar-time-grid-scroll');
  await expect(scroller).toBeVisible();
  return scroller;
}

// Where the today column sits relative to the visible window, and whether the scroller
// is the element that actually owns the horizontal overflow.
const weekGeometry = page => page.evaluate(() => {
  const scroller = document.querySelector('[data-testid="calendar-time-grid-scroll"]');
  const grid = document.querySelector('[data-testid="calendar-grid"]');
  const today = scroller.querySelector('[data-calendar-today="true"]');
  const scrollerRect = scroller.getBoundingClientRect();
  const todayRect = today.getBoundingClientRect();
  return {
    // Distance between the column centre and the viewport centre; ~0 means centred.
    centreOffset: Math.round((todayRect.left + todayRect.width / 2) - (scrollerRect.left + scrollerRect.width / 2)),
    todayFullyVisible: todayRect.left >= scrollerRect.left - 1 && todayRect.right <= scrollerRect.right + 1,
    scrollLeft: Math.round(scroller.scrollLeft),
    // The scroller must be the one with the horizontal overflow...
    scrollerOverflowX: getComputedStyle(scroller).overflowX,
    scrollerHorizontalOverflow: scroller.scrollWidth - scroller.clientWidth,
    // ...and the wrapper around it must not be a second scroller in that axis.
    gridOverflowX: getComputedStyle(grid).overflowX,
    gridHorizontalOverflow: grid.scrollWidth - grid.clientWidth,
  };
});

for (const view of ['week', 'workweek']) {
  test(`${view} view on a phone opens centred on today`, async ({ page, fixtureApi }, testInfo) => {
    test.skip(!['chromium-mobile-390', 'chromium-mobile'].includes(testInfo.project.name), 'phone week grid contract');
    await fixtureApi;
    const scroller = await openCalendarOnPhone(page, view);

    // Today is mid-week, so it must land in the middle rather than at the left edge.
    await expect.poll(async () => Math.abs((await weekGeometry(page)).centreOffset)).toBeLessThanOrEqual(2);

    const geometry = await weekGeometry(page);
    expect(geometry.todayFullyVisible).toBe(true);
    expect(geometry.scrollLeft).toBeGreaterThan(0);
    // One container owns both axes: the scroller itself overflows horizontally, and the
    // wrapper around it does not. A nested pair is what caused the stuttering pan.
    expect(geometry.scrollerHorizontalOverflow).toBeGreaterThan(0);
    expect(geometry.scrollerOverflowX).toBe('auto');
    expect(geometry.gridOverflowX).toBe('hidden');
    expect(geometry.gridHorizontalOverflow).toBeLessThanOrEqual(0);

    await expect(scroller).toBeVisible();
  });
}

test('a phone week grid pans horizontally within its single container', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-mobile-390', 'chromium-mobile'].includes(testInfo.project.name), 'phone week grid contract');
  await fixtureApi;
  const scroller = await openCalendarOnPhone(page, 'week');

  // The user can still reach the rest of the week by panning the one container.
  await scroller.evaluate(element => { element.scrollLeft = 0; });
  await expect.poll(() => weekGeometry(page).then(geometry => geometry.scrollLeft)).toBe(0);
  await scroller.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  const geometry = await weekGeometry(page);
  expect(geometry.scrollLeft).toBeGreaterThan(0);
});

test('selecting a day inside the visible week does not move the grid', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-mobile-390', 'chromium-mobile'].includes(testInfo.project.name), 'phone week grid contract');
  await fixtureApi;
  const scroller = await openCalendarOnPhone(page, 'week');
  await expect.poll(async () => Math.abs((await weekGeometry(page)).centreOffset)).toBeLessThanOrEqual(2);

  // Pan to a position that is neither the open position (today centred) nor an edge, then
  // select a day that is already on screen. Re-centring here would yank the grid out from
  // under the finger, so the view must stay exactly where the user left it.
  await scroller.evaluate(element => { element.scrollLeft = 400; });
  await expect.poll(() => weekGeometry(page).then(geometry => geometry.scrollLeft)).toBe(400);
  await scroller.locator('[data-calendar-day-index="3"]').click();
  await expect.poll(() => weekGeometry(page).then(geometry => geometry.scrollLeft)).toBe(400);
});
