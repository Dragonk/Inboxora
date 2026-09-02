import { test, expect } from './fixtures.js';

test('calendar and contacts remain reachable and their mobile FABs clear bottom panels', async ({ page, fixtureApi }, testInfo) => {
  await fixtureApi;
  await page.goto('/');

  if (page.viewportSize().width < 768) {
    const navigation = page.getByTestId('mobile-primary-nav');
    await expect(navigation).toBeVisible();

    await navigation.getByRole('button', { name: 'Kontakty' }).click();
    await expect(page.getByTestId('contacts-mobile-list')).toBeVisible();
    const [contactsFab, navBox] = await Promise.all([
      page.getByTestId('contacts-mobile-fab').boundingBox(),
      navigation.boundingBox(),
    ]);
    expect(contactsFab.y + contactsFab.height).toBeLessThanOrEqual(navBox.y + 1);

    await navigation.getByRole('button', { name: 'Kalendarz' }).click();
    await expect(page.getByTestId('calendar-mobile-new-event')).toBeVisible();
    await page.getByRole('button', { name: 'Kalendarze' }).click();
    const dock = page.getByTestId('calendar-mobile-dock');
    await expect(dock).toBeVisible();
    await expect(page.getByTestId('calendar-mobile-new-event')).toBeHidden();
    const dockBox = await dock.boundingBox();
    expect(dockBox.y + dockBox.height).toBeLessThanOrEqual(navBox.y + 1);

    await navigation.getByRole('button', { name: 'Wszystkie skrzynki odbiorcze' }).click();
    await expect(navigation.getByRole('button', { name: 'Wszystkie skrzynki odbiorcze' })).toHaveAttribute('aria-current', 'page');
  } else {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByTestId('calendar-nav-primary').click();
    const calendarRoot = page.getByTestId('calendar-page');
    await expect(page.getByTestId('calendar-sidebar')).toBeVisible();
    await expect(page.getByTestId('calendar-mini-month')).toBeVisible();
    await expect(calendarRoot).toBeVisible();
    const [rootBox, sidebarBox] = await Promise.all([
      calendarRoot.boundingBox(),
      page.getByTestId('calendar-sidebar').boundingBox(),
    ]);
    expect(Math.abs(rootBox.x + rootBox.width - page.viewportSize().width)).toBeLessThanOrEqual(1);
    expect(sidebarBox.width).toBe(280);
    await page.screenshot({ path: testInfo.outputPath('desktop-calendar-1280x800.png') });
    await page.getByTestId('contacts-nav-primary').click();
    await expect(page.getByTestId('contacts-desktop-list')).toBeVisible();
    await expect(page.getByTestId('contacts-desktop-detail')).toBeVisible();
  }
});

test('mobile contacts fill the viewport and keep their FAB anchored above navigation', async ({ page, fixtureApi }) => {
  await fixtureApi;
  await page.route('**/api/contacts**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/contact-1')) {
      return route.fulfill({ json: {
        id: 'contact-1', display_name: 'Jan Testowy', primary_email: 'jan@example.test',
        emails: [{ value: 'jan@example.test', type: 'work' }], phones: [],
      } });
    }
    return route.fulfill({ json: {
      contacts: [{ id: 'contact-1', display_name: 'Jan Testowy', primary_email: 'jan@example.test' }], total: 1,
    } });
  });
  await page.goto('/');

  if (page.viewportSize().width < 768) {
    const viewport = page.viewportSize();
    const navigation = page.getByTestId('mobile-primary-nav');
    await navigation.getByRole('button', { name: 'Kontakty' }).click();

    const list = page.getByTestId('contacts-mobile-list');
    const fab = page.getByTestId('contacts-mobile-fab');
    await expect(list).toBeVisible();
    await expect(fab).toBeVisible();
    await page.waitForFunction(() => Array.from(document.getAnimations()).every(animation => animation.playState !== 'running'));
    const [listBox, fabBox, navBox] = await Promise.all([
      list.boundingBox(), fab.boundingBox(), navigation.boundingBox(),
    ]);
    expect(listBox.x).toBe(0);
    expect(listBox.width).toBe(viewport.width);
    expect(fabBox.x + fabBox.width).toBe(viewport.width - 20);
    expect(navBox.y - (fabBox.y + fabBox.height)).toBeGreaterThanOrEqual(20);

    const hitTests = await page.evaluate(({ fabCenter, navCenters }) => ({
      fab: document.elementFromPoint(fabCenter.x, fabCenter.y)?.closest('[data-testid="contacts-mobile-fab"]') != null,
      navigation: navCenters.map(({ x, y }) => document.elementFromPoint(x, y)?.tagName === 'BUTTON'),
    }), {
      fabCenter: { x: fabBox.x + fabBox.width / 2, y: fabBox.y + fabBox.height / 2 },
      navCenters: await Promise.all(['Wszystkie skrzynki odbiorcze', 'Kontakty', 'Kalendarz'].map(async name => {
        const box = await navigation.getByRole('button', { name }).boundingBox();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      })),
    });
    expect(hitTests.fab).toBe(true);
    expect(hitTests.navigation).toEqual([true, true, true]);

    await page.getByText('Jan Testowy', { exact: true }).click();
    await expect(page.getByTestId('contacts-mobile-detail')).toBeVisible();
    await page.waitForFunction(() => Array.from(document.getAnimations()).every(animation => animation.playState !== 'running'));
    const detailBox = await page.getByTestId('contacts-mobile-detail').boundingBox();
    expect(detailBox.x).toBe(0);
    expect(detailBox.width).toBe(viewport.width);
    await page.getByTestId('contacts-mobile-detail').locator('..').getByRole('button').first().click();
    await expect(list).toBeVisible();
  }
});

test('mobile calendar fits the full localized week and keeps every dock control hittable', async ({ page, fixtureApi }) => {
  await fixtureApi;
  await page.goto('/');

  if (page.viewportSize().width >= 768) return;

  const navigation = page.getByTestId('mobile-primary-nav');
  await navigation.getByRole('button', { name: 'Kalendarz' }).click();
  const grid = page.getByTestId('calendar-month-grid');
  const headers = grid.getByTestId('calendar-weekday');
  await expect(headers).toHaveCount(7);
  await expect(headers.nth(6)).toBeVisible();
  expect(await grid.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(await grid.evaluate(element => element.clientWidth));

  const expectedWeekdays = await page.evaluate(() => Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat('pl', { weekday: 'short' }).format(new Date(2024, 0, index + 1))));
  await expect(headers).toHaveText(expectedWeekdays);

  await page.getByRole('button', { name: 'Kalendarze' }).click();
  const dock = page.getByTestId('calendar-mobile-dock');
  const miniMonth = page.getByTestId('calendar-mini-month');
  await expect(dock).toBeVisible();
  await expect(miniMonth.getByTestId('calendar-mini-weekday')).toHaveText(expectedWeekdays);
  const [toggleBox, miniBox, dockBox] = await Promise.all([
    page.getByRole('button', { name: 'Kalendarze' }).boundingBox(),
    miniMonth.boundingBox(),
    dock.boundingBox(),
  ]);
  expect(toggleBox.y + toggleBox.height <= miniBox.y || miniBox.y + miniBox.height <= toggleBox.y).toBe(true);
  await expect(page.getByTestId('calendar-mobile-new-event')).toBeHidden();

  const interactiveControls = await dock.getByRole('button').evaluateAll(buttons => buttons.filter(button => {
    const box = button.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= window.innerHeight;
  }).map(button => {
    const box = button.getBoundingClientRect();
    const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return target === button || target?.closest('button') === button;
  }));
  expect(interactiveControls.length).toBeGreaterThan(0);
  expect(interactiveControls.every(Boolean)).toBe(true);
});

test('calendar weekday headings use the active English locale', async ({ page, fixtureApi }) => {
  page.__languageOverride = 'en';
  await fixtureApi;
  await page.goto('/');

  const calendarControl = page.viewportSize().width < 768
    ? page.getByTestId('mobile-primary-nav').getByRole('button', { name: 'Calendar' })
    : page.getByTestId('calendar-nav-primary');
  await calendarControl.click();
  const headers = page.getByTestId('calendar-month-grid').getByTestId('calendar-weekday');
  const expectedWeekdays = await page.evaluate(() => Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat('en', { weekday: 'short' }).format(new Date(2024, 0, index + 1))));
  await expect(headers).toHaveText(expectedWeekdays);
  if (page.viewportSize().width < 768) await page.getByRole('button', { name: 'Calendars' }).click();
  await expect(page.getByTestId('calendar-mini-month').getByTestId('calendar-mini-weekday')).toHaveText(expectedWeekdays);
});

test('mobile primary navigation re-enters Contacts and Calendar at their roots without retaining hidden editor focus', async ({ page, fixtureApi }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixtureApi;
  await page.route('**/api/contacts**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/contact-1')) {
      return route.fulfill({ json: {
        id: 'contact-1', display_name: 'Jan Testowy', primary_email: 'jan@example.test',
        emails: [{ value: 'jan@example.test', type: 'work' }], phones: [],
      } });
    }
    return route.fulfill({ json: {
      contacts: [{ id: 'contact-1', display_name: 'Jan Testowy', primary_email: 'jan@example.test' }], total: 1,
    } });
  });
  await page.goto('/');

  const navigation = page.getByTestId('mobile-primary-nav');
  const mail = navigation.getByRole('button', { name: 'Wszystkie skrzynki odbiorcze' });
  const contacts = navigation.getByRole('button', { name: 'Kontakty' });
  const calendar = navigation.getByRole('button', { name: 'Kalendarz' });

  await contacts.click();
  await page.getByText('Jan Testowy', { exact: true }).click();
  await expect(page.getByTestId('contacts-mobile-detail')).toBeVisible();
  await mail.click();
  await contacts.click();
  await expect(page.getByTestId('contacts-mobile-list')).toBeVisible();
  await expect(page.getByTestId('contacts-mobile-detail')).toBeHidden();
  await expect(contacts).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="contacts-mobile-detail"]') === null)).toBe(true);

  await calendar.click();
  await page.getByTestId('calendar-mobile-new-event').click();
  const editorInput = page.getByTestId('calendar-event-dialog').getByRole('textbox').first();
  await expect(editorInput).toBeFocused();
  await mail.click();
  await calendar.click();
  await expect(page.getByTestId('calendar-month-grid')).toBeVisible();
  await expect(page.getByTestId('calendar-mobile-dock')).toBeHidden();
  expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="calendar-event-dialog"]') === null)).toBe(true);
  await expect(calendar).toBeFocused();
});

test('mobile Contacts exposes contextual back-button names and preserves focus after keyboard activation', async ({ page, fixtureApi }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixtureApi;
  await page.route('**/api/contacts**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/contact-1')) {
      return route.fulfill({ json: {
        id: 'contact-1', display_name: 'Jan Testowy', primary_email: 'jan@example.test',
        emails: [{ value: 'jan@example.test', type: 'work' }], phones: [],
      } });
    }
    return route.fulfill({ json: {
      contacts: [{ id: 'contact-1', display_name: 'Jan Testowy', primary_email: 'jan@example.test' }], total: 1,
    } });
  });
  await page.goto('/');

  const navigation = page.getByTestId('mobile-primary-nav');
  await navigation.getByRole('button', { name: 'Kontakty' }).click();
  const backToMail = page.getByRole('button', { name: 'Wróć do poczty' });
  await expect(backToMail).toBeVisible();
  await backToMail.focus();
  await expect(backToMail).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(navigation.getByRole('button', { name: 'Wszystkie skrzynki odbiorcze' })).toHaveAttribute('aria-current', 'page');

  await navigation.getByRole('button', { name: 'Kontakty' }).click();
  await page.getByText('Jan Testowy', { exact: true }).click();
  await expect(page.getByTestId('contacts-mobile-detail')).toBeVisible();
  const backToContacts = page.getByRole('button', { name: 'Wróć do listy kontaktów' });
  await expect(backToContacts).toBeVisible();
  await backToContacts.focus();
  await expect(backToContacts).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('contacts-mobile-list')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Jan Testowy', exact: true })).toBeFocused();
});

test('mobile contact rows are reachable by Tab and restore focus after Enter and Space activation', async ({ page, fixtureApi }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixtureApi;
  await page.route('**/api/contacts**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/contact-1')) {
      return route.fulfill({ json: {
        id: 'contact-1', display_name: 'Jan Testowy', primary_email: 'jan@example.test',
        emails: [{ value: 'jan@example.test', type: 'work' }], phones: [],
      } });
    }
    return route.fulfill({ json: {
      contacts: [{ id: 'contact-1', display_name: 'Jan Testowy', primary_email: 'jan@example.test' }], total: 1,
    } });
  });
  await page.goto('/');

  await page.getByTestId('mobile-primary-nav').getByRole('button', { name: 'Kontakty' }).click();
  const search = page.getByPlaceholder('Szukaj kontaktów');
  const row = page.getByRole('button', { name: 'Jan Testowy', exact: true });
  const backToList = page.getByRole('button', { name: 'Wróć do listy kontaktów' });

  await search.focus();
  await page.keyboard.press('Tab');
  await expect(row).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('contacts-mobile-detail')).toBeVisible();
  await expect(backToList).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(row).toBeFocused();

  await page.keyboard.press('Space');
  await expect(page.getByTestId('contacts-mobile-detail')).toBeVisible();
  await expect(backToList).toBeFocused();
  await page.keyboard.press('Space');
  await expect(row).toBeFocused();
});

test('desktop contact rows expose their visible name and activate with the keyboard', async ({ page, fixtureApi }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await fixtureApi;
  await page.route('**/api/contacts**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/contact-1')) {
      return route.fulfill({ json: {
        id: 'contact-1', display_name: 'Jan Testowy', primary_email: 'jan@example.test',
        emails: [{ value: 'jan@example.test', type: 'work' }], phones: [],
      } });
    }
    return route.fulfill({ json: {
      contacts: [{ id: 'contact-1', display_name: 'Jan Testowy', primary_email: 'jan@example.test' }], total: 1,
    } });
  });
  await page.goto('/');

  await page.getByTestId('contacts-nav-primary').click();
  const search = page.getByPlaceholder('Szukaj kontaktów');
  const row = page.getByRole('button', { name: 'Jan Testowy', exact: true });
  await search.focus();
  await page.keyboard.press('Tab');
  await expect(row).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('contacts-desktop-detail').getByRole('heading', { name: 'Jan Testowy' })).toBeVisible();
});

test('mobile long Contacts and Mail lists keep their final rows above fixed navigation and FABs', async ({ page, fixtureApi }) => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 412, height: 915 }]) {
    await page.setViewportSize(viewport);
    page.__largeMailboxRows = 100;
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
    await page.goto('/');

    const navigation = page.getByTestId('mobile-primary-nav');
    await navigation.getByRole('button', { name: 'Kontakty' }).click();
    const contactsList = page.getByTestId('contacts-list-scroll');
    const lastContact = page.getByRole('button', { name: 'Kontakt 100', exact: true });
    await contactsList.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
    await expect(lastContact).toBeVisible();

    const contactsGeometry = await page.evaluate(() => {
      const row = document.querySelector('[data-contact-id="contact-100"]')?.getBoundingClientRect();
      const nav = document.querySelector('[data-testid="mobile-primary-nav"]')?.getBoundingClientRect();
      const fab = document.querySelector('[data-testid="contacts-mobile-fab"]')?.getBoundingClientRect();
      const hit = row && document.elementFromPoint(row.x + row.width / 2, row.y + row.height / 2)?.closest('[data-contact-id]')?.getAttribute('data-contact-id');
      return { row: row && { top: row.top, bottom: row.bottom }, nav: nav && { top: nav.top }, fab: fab && { top: fab.top }, hit };
    });
    expect(contactsGeometry.row.bottom).toBeLessThanOrEqual(contactsGeometry.nav.top);
    expect(contactsGeometry.row.bottom).toBeLessThanOrEqual(contactsGeometry.fab.top - 20);
    expect(contactsGeometry.hit).toBe('contact-100');

    await lastContact.click();
    await expect(page.getByTestId('contacts-mobile-detail')).toBeVisible();
    await page.getByRole('button', { name: 'Wróć do listy kontaktów' }).click();
    await lastContact.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('contacts-mobile-detail')).toBeVisible();
    await page.getByRole('button', { name: 'Wróć do listy kontaktów' }).click();
    await lastContact.focus();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('contacts-mobile-detail')).toBeVisible();

    await navigation.getByRole('button', { name: 'Wszystkie skrzynki odbiorcze' }).click();
    const mailboxList = page.getByTestId('message-list-scroll');
    const lastMessage = page.locator('[data-msgid="large-row-99"]');
    await mailboxList.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
    await expect(lastMessage).toBeVisible();
    const mailGeometry = await page.evaluate(() => {
      const row = document.querySelector('[data-msgid="large-row-99"]')?.getBoundingClientRect();
      const nav = document.querySelector('[data-testid="mobile-primary-nav"]')?.getBoundingClientRect();
      const hit = row && document.elementFromPoint(row.x + row.width / 2, row.y + row.height / 2)?.closest('[data-msgid]')?.getAttribute('data-msgid');
      return { row: row && { bottom: row.bottom }, nav: nav && { top: nav.top }, hit };
    });
    expect(mailGeometry.row.bottom).toBeLessThanOrEqual(mailGeometry.nav.top);
    expect(mailGeometry.hit).toBe('large-row-99');
  }
});
