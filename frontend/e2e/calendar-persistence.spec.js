import { test, expect } from './fixtures.js';
import { setupV3, navigateModule } from './v3-fixtures.js';
import { returnToMail, selectCalendarView } from './navigation.js';

// The calendar view is remembered per device: leaving the calendar (which unmounts
// the page) and reloading the app both keep the last view. Panel widths persist too.
for (const project of ['chromium-desktop', 'chromium-mobile-390']) {
  test(`calendar remembers the view and panel widths (${project})`, async ({ page, fixtureApi }, testInfo) => {
    test.skip(testInfo.project.name !== project, 'targeted');
    await fixtureApi;
    await setupV3(page);
    // The day-agenda column only exists when the surface is wide enough to hold both
    // side columns, so give the desktop run the room it needs before measuring.
    if (page.viewportSize().width >= 768) await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto('/');
    await navigateModule(page, 'calendar');

    const readView = async () => page.evaluate(() => {
      const pressed = document.querySelector('[data-testid^="calendar-view-"][aria-pressed="true"]');
      if (pressed) return pressed.getAttribute('data-testid');
      return document.querySelector('[data-testid="calendar-view-select"]')?.value ?? null;
    });
    const expected = view => (page.viewportSize().width < 768 ? view : `calendar-view-${view}`);

    expect(await readView()).toBe(expected('month'));

    // Switch to the work week.
    await selectCalendarView(page, 'workweek');
    await expect.poll(readView).toBe(expected('workweek'));

    // Leaving the calendar unmounts the page; coming back must keep the view.
    if (page.viewportSize().width < 768) {
      await page.getByTestId('mobile-topbar-menu').click();
      await page.getByText('Gmail fixture', { exact: true }).click();
    } else {
      await returnToMail(page);
    }
    await expect(page.getByTestId('calendar-page')).toHaveCount(0);
    await navigateModule(page, 'calendar');
    expect(await readView(), 'view survives leaving and returning').toBe(expected('workweek'));

    // A full reload must keep it as well.
    await page.reload();
    await navigateModule(page, 'calendar');
    expect(await readView(), 'view survives a reload').toBe(expected('workweek'));

    // Panel widths persist across a reload too.
    if (page.viewportSize().width >= 768) {
      const handle = page.getByTestId('calendar-agenda-resize');
      const box = await handle.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 200);
      await page.mouse.down();
      await page.mouse.move(box.x - 80, box.y + 200, { steps: 10 });
      await page.mouse.up();
      const dragged = await page.evaluate(() => localStorage.getItem('mailflow_agenda_width'));
      expect(dragged, 'the dragged width is persisted').not.toBeNull();
      await page.reload();
      await navigateModule(page, 'calendar');
      const restored = await page.evaluate(() => Math.round(document.querySelector('.calendar-agenda').getBoundingClientRect().width));
      expect(String(restored), 'the width is restored after a reload').toBe(dragged);
    }
  });
}
