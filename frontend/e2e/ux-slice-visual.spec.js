import { test, expect } from './fixtures.js';

test('mobile UX slice keeps mail, contacts, calendar and settings visually reachable at 390px', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile-390', '390px visual acceptance');
  await fixtureApi;
  page.__conversationMatrix = '01';
  const listLoaded = page.waitForResponse(response => response.request().method() === 'GET' && response.ok() && new URL(response.url()).pathname === '/api/mail/messages');
  await page.goto('/?list=0&reader=1', { waitUntil: 'domcontentloaded' });
  await listLoaded;
  await expect(page.locator('[data-ce-reader-enabled]:visible').first()).toHaveAttribute('data-ce-reader-enabled', 'true');
  await expect(page.getByTestId('mobile-menu')).toBeVisible();
  await page.screenshot({ path: 'artifacts/ux-slice-mail-list-390.png', fullPage: true });
  await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
  await expect(page.locator('[data-testid="message-pane-toolbar"]:visible')).toBeVisible();
  await page.screenshot({ path: 'artifacts/ux-slice-mail-preview-390.png', fullPage: true });
  await page.goto('/?list=0&reader=1', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('mobile-menu')).toBeVisible();
  await page.getByTestId('mobile-menu').click();
  await page.getByTestId('contacts-nav-mobile').click();
  await expect(page.getByTestId('mobile-contacts-page')).toBeVisible();
  await page.screenshot({ path: 'artifacts/ux-slice-contacts-390.png', fullPage: true });
  await page.getByTestId('contacts-mobile-menu').click();
  await page.getByTestId('calendar-nav-mobile').click();
  await expect(page.getByTestId('calendar-grid')).toBeVisible();
  const calendarPage = page.getByTestId('mobile-calendar-page');
  await expect(calendarPage.getByRole('group', { name: /widok kalendarza/i })).toBeVisible();
  const headerControls = await calendarPage.locator('[data-testid="calendar-page"] header button:visible').evaluateAll(buttons => buttons.map(button => { const box = button.getBoundingClientRect(); return { left: box.left, right: box.right }; }));
  expect(headerControls.length).toBeGreaterThan(0);
  for (const control of headerControls) { expect(control.left).toBeGreaterThanOrEqual(0); expect(control.right).toBeLessThanOrEqual(390); }
  await page.screenshot({ path: 'artifacts/ux-slice-calendar-390.png', fullPage: true });
  await page.getByTestId('calendar-mobile-menu').click();
  await page.getByTestId('mobile-sidebar').getByText(/e2e@example\.test/i).first().evaluate(element => element.parentElement?.click());
  await expect(page.getByTestId('mobile-settings')).toBeVisible();
  await page.getByTestId('mobile-settings').click();
  await expect(page.getByText(/Ustawienia|Settings/i).first()).toBeVisible();
  await page.screenshot({ path: 'artifacts/ux-slice-settings-390.png', fullPage: true });
});
