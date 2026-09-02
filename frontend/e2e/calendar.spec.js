import { test, expect } from './fixtures.js';

const openMobileDestination = async (page, testId) => {
  const menu = page.getByTestId('mobile-menu').or(page.getByTestId('contacts-mobile-menu')).or(page.getByTestId('calendar-mobile-menu'));
  await menu.filter({ visible: true }).click();
  await page.getByTestId(testId).click();
};

test('desktop Calendar and Contacts retain the mail-style split layout', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop layout contract');
  await fixtureApi;
  await page.goto('/?list=0&reader=0');

  await page.getByTestId('calendar-nav-primary').click();
  const calendar = page.getByTestId('calendar-page');
  const calendarSidebar = page.getByTestId('calendar-sidebar');
  const miniMonth = page.getByTestId('calendar-mini-month');
  await expect(calendar).toBeVisible();
  await expect(calendarSidebar).toBeVisible();
  await expect(miniMonth).toBeVisible();
  expect((await calendarSidebar.boundingBox()).width).toBe(280);

  const monthBefore = await miniMonth.locator('strong').textContent();
  await miniMonth.getByRole('button', { name: 'Poprzedni okres' }).click();
  await expect(miniMonth.locator('strong')).not.toHaveText(monthBefore);

  await page.getByTestId('contacts-nav-primary').click();
  await expect(page.getByTestId('contacts-desktop-list')).toBeVisible();
  await expect(page.getByTestId('contacts-desktop-detail')).toBeVisible();
  expect((await page.getByTestId('contacts-desktop-list').boundingBox()).width).toBe(280);
});

test('mobile Calendar starts at the grid and keeps its panel and event action usable', async ({ page, fixtureApi }) => {
  test.skip(page.viewportSize().width >= 768, 'mobile layout contract');
  page.__mobileNavigationPositionOverride = 'bottom';
  await fixtureApi;
  await page.goto('/?list=0&reader=0');

  await openMobileDestination(page, 'calendar-nav-mobile');
  await expect(page.getByTestId('calendar-grid')).toBeVisible();
  const navigation = page.getByTestId('mobile-calendar-page').locator('header');
  const eventAction = page.getByTestId('calendar-mobile-new-event');
  const [navigationBox, actionBox] = await Promise.all([navigation.boundingBox(), eventAction.boundingBox()]);
  expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(navigationBox.y);

  await page.getByTestId('calendar-mobile-panel').click();
  const panel = page.getByTestId('calendar-mobile-dock');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('calendar-mini-month')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Poprzedni okres' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Następny okres' })).toBeVisible();
});

test('mobile Contacts is list-first, keyboard accessible, re-entry safe, and clears its FAB', async ({ page, fixtureApi }) => {
  test.skip(page.viewportSize().width >= 768, 'mobile contacts contract');
  await fixtureApi;
  const contacts = Array.from({ length: 100 }, (_, index) => ({
    id: `contact-${index + 1}`,
    display_name: `Kontakt ${index + 1}`,
    primary_email: `kontakt-${index + 1}@example.test`,
  }));
  await page.route('**/api/contacts**', route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    if (id?.startsWith('contact-')) {
      const contact = contacts.find(item => item.id === id);
      return route.fulfill({ json: { ...contact, emails: [{ value: contact.primary_email, type: 'work' }], phones: [] } });
    }
    return route.fulfill({ json: { contacts, total: contacts.length } });
  });
  await page.goto('/?list=0&reader=0');

  await openMobileDestination(page, 'contacts-nav-mobile');
  const list = page.getByTestId('contacts-mobile-list');
  const scroll = page.getByTestId('contacts-list-scroll');
  const last = page.getByRole('button', { name: 'Kontakt 100', exact: true });
  const fab = page.getByTestId('contacts-mobile-fab');
  await expect(list).toBeVisible();
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
  await expect(last).toBeVisible();

  const [lastBox, fabBox] = await Promise.all([last.boundingBox(), fab.boundingBox()]);
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(fabBox.y - 20);
  expect(await last.evaluate(element => document.elementFromPoint(
    element.getBoundingClientRect().x + element.getBoundingClientRect().width / 2,
    element.getBoundingClientRect().y + element.getBoundingClientRect().height / 2,
  )?.closest('[data-contact-id]')?.getAttribute('data-contact-id'))).toBe('contact-100');

  await last.focus();
  await page.keyboard.press('Enter');
  const detail = page.getByTestId('contacts-mobile-detail');
  const back = page.getByRole('button', { name: 'Wróć do listy kontaktów' });
  await expect(detail).toBeVisible();
  await expect(back).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(last).toBeFocused();

  await page.keyboard.press('Space');
  await expect(detail).toBeVisible();
  await back.click();
  await openMobileDestination(page, 'calendar-nav-mobile');
  await openMobileDestination(page, 'contacts-nav-mobile');
  await expect(list).toBeVisible();
  await expect(detail).toBeHidden();
});

test('mobile Mail leaves its final row above the compose action', async ({ page, fixtureApi }) => {
  test.skip(page.viewportSize().width >= 768, 'mobile mail list contract');
  page.__largeMailboxRows = 100;
  await fixtureApi;
  await page.goto('/?list=0&reader=0');

  const scroll = page.getByTestId('message-list-scroll');
  const last = page.locator('[data-msgid="large-row-99"]');
  const compose = page.getByRole('button', { name: 'Napisz nową wiadomość' });
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
  await expect(last).toBeVisible();
  const [lastBox, composeBox] = await Promise.all([last.boundingBox(), compose.boundingBox()]);
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(composeBox.y);
});
