import { test, expect } from './fixtures.js';

test('remote ICS first sync failure can be retried without duplicating the imported event', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop source management contract');
  await fixtureApi;
  const source = { id: 'source-retry', kind: 'ical_url', displayName: 'RetryICS', url: 'https://calendar.example/retry.ics', lastError: null, lastSyncAt: null };
  let syncAttempts = 0;
  let eventPresent = false;
  let created = false;
  await page.route('**/api/calendar/events**', route => route.fulfill({ json: { events: eventPresent ? [{ id: 'remote-event-1', calendar_id: 'calendar-remote', summary: 'Remote standup', starts_at: '2026-09-03T09:00:00.000Z', ends_at: '2026-09-03T09:30:00.000Z' }] : [] } }));
  await page.route('**/api/calendar/sources**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.endsWith('/sync')) {
      syncAttempts += 1;
      eventPresent = true;
      return route.fulfill({ json: { ok: true, imported: 1, updated: 0, rejected: 0 } });
    }
    if (request.method() === 'POST') { created = true; return route.fulfill({ status: 502, json: { error: 'fixture fetch failed', source, sync: { ok: false, error: 'fixture fetch failed' } } }); }
    const failed = created && syncAttempts === 0;
    return route.fulfill({ json: { sources: [{ ...source, lastError: failed ? 'fixture fetch failed' : null, lastSyncAt: failed ? null : '2026-09-03T09:01:00.000Z' }] } });
  });
  await page.goto('/?list=0&reader=0');
  await page.getByTestId('calendar-nav-primary').click();
  await page.getByTestId('calendar-sidebar-manage-sources').click();
  const dialog = page.getByRole('dialog', { name: 'Zarządzaj źródłami' });
  await dialog.getByLabel('Nazwa', { exact: true }).fill(source.displayName);
  await dialog.getByLabel('Adres URL').fill('webcal://calendar.example/retry.ics');
  await dialog.getByRole('button', { name: 'Dodaj źródło' }).click();
  await expect(dialog.getByText('fixture fetch failed')).toBeVisible();
  await dialog.getByRole('button', { name: 'Synchronizuj' }).click();
  await expect(page.getByText('Remote standup', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Gotowe')).toBeVisible();
  expect(syncAttempts).toBe(1);
  await expect(page.getByText('Remote standup', { exact: true })).toHaveCount(1);
});

test('invalid remote ICS URL surfaces a meaningful error instead of creating a source', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop source management contract');
  await fixtureApi;
  await page.route('**/api/calendar/sources**', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 400, json: { error: 'Invalid calendar source URL' } })
    : route.fulfill({ json: { sources: [] } }));
  await page.goto('/?list=0&reader=0');
  await page.getByTestId('calendar-nav-primary').click();
  await page.getByTestId('calendar-sidebar-manage-sources').click();
  const dialog = page.getByRole('dialog', { name: 'Zarządzaj źródłami' });
  await dialog.getByLabel('Nazwa', { exact: true }).fill('InvalidICS');
  await dialog.getByLabel('Adres URL').fill('https://calendar.example/not-an-ics');
  await dialog.getByRole('button', { name: 'Dodaj źródło' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Invalid calendar source URL');
  await expect(dialog.getByText('InvalidICS')).toHaveCount(0);
});

test('removing a remote ICS source refreshes events and prevents its stale event from returning', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop source management contract');
  await fixtureApi;
  const source = { id: 'source-remove', kind: 'ical_url', displayName: 'RemoveICS', url: 'https://calendar.example/remove.ics', lastError: null, lastSyncAt: '2026-09-03T09:00:00.000Z' };
  let removed = false;
  await page.route('**/api/calendar/events**', route => route.fulfill({ json: { events: removed ? [] : [{ id: 'stale-remote-event', calendar_id: 'calendar-remote', summary: 'Stale remote event', starts_at: '2026-09-03T10:00:00.000Z', ends_at: '2026-09-03T10:30:00.000Z' }] } }));
  await page.route('**/api/calendar/sources**', route => {
    const request = route.request();
    if (request.method() === 'DELETE') { removed = true; return route.fulfill({ json: { ok: true } }); }
    if (request.method() === 'POST') return route.fulfill({ status: 201, json: { source } });
    return route.fulfill({ json: { sources: removed ? [] : [source] } });
  });
  await page.goto('/?list=0&reader=0');
  await page.getByTestId('calendar-nav-primary').click();
  await expect(page.getByText('Stale remote event', { exact: true })).toBeVisible();
  await page.getByTestId('calendar-sidebar-manage-sources').click();
  const dialog = page.getByRole('dialog', { name: 'Zarządzaj źródłami' });
  await expect(dialog.getByText(source.displayName)).toBeVisible();
  await dialog.getByRole('button', { name: 'Usuń' }).click();
  await expect(dialog.getByText(source.displayName)).toHaveCount(0);
  await expect(page.getByText('Stale remote event', { exact: true })).toHaveCount(0);
});


test('deleting a pending ICS source cancels its initial-sync polling', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop source management contract');
  await fixtureApi;
  const source = { id: 'source-pending-delete', kind: 'ical_url', displayName: 'UsuwanyICS', url: 'https://calendar.example/pending-delete.ics', lastError: null, lastSyncAt: null };
  let sources = [];
  let sourceListRequests = 0;
  let deleted = false;
  await page.route('**/api/calendar/sources**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.endsWith('/sync')) return route.fulfill({ json: { ok: true } });
    if (request.method() === 'POST') {
      sources = [source];
      return route.fulfill({ status: 201, json: { source, sync: { pending: true } } });
    }
    if (request.method() === 'DELETE') {
      deleted = true;
      sources = [];
      return route.fulfill({ json: { ok: true } });
    }
    sourceListRequests += 1;
    return route.fulfill({ json: { sources: deleted ? [] : sources } });
  });
  await page.goto('/?list=0&reader=0');
  await page.getByTestId('calendar-nav-primary').click();
  await page.getByTestId('calendar-sidebar-manage-sources').click();
  const dialog = page.getByRole('dialog', { name: 'Zarządzaj źródłami' });
  await dialog.getByLabel('Nazwa', { exact: true }).fill(source.displayName);
  await dialog.getByLabel('Adres URL').fill('webcal://calendar.example/pending-delete.ics');
  await dialog.getByRole('button', { name: 'Dodaj źródło' }).click();
  await expect(dialog.getByText(source.displayName)).toBeVisible();
  await expect(dialog.getByText('Synchronizowanie…')).toBeVisible();
  await dialog.getByRole('button', { name: 'Usuń' }).click();
  await expect(dialog.getByText(source.displayName)).toHaveCount(0);
  const requestCountAfterDelete = sourceListRequests;
  await page.waitForTimeout(1200);
  expect(sourceListRequests).toBe(requestCountAfterDelete);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('remote ICS source does not poll after terminal successful creation', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop source management contract');
  await fixtureApi;
  let refreshCount = 0;
  const source = { id: 'source-timeout', kind: 'ical_url', displayName: 'NiedostepnyICS', url: 'https://calendar.example/timeout.ics', lastError: null, lastSyncAt: new Date().toISOString() };
  await page.route('**/api/calendar/sources**', async route => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 201, json: { source, sync: { ok: true, eventCount: 1 } } });
    refreshCount += 1;
    return route.fulfill({ json: { sources: [source] } });
  });
  await page.goto('/?list=0&reader=0');
  await page.getByTestId('calendar-nav-primary').click();
  await page.getByTestId('calendar-sidebar-manage-sources').click();
  const dialog = page.getByRole('dialog', { name: 'Zarządzaj źródłami' });
  await dialog.getByLabel('Nazwa', { exact: true }).fill('NiedostepnyICS');
  await dialog.getByLabel('Adres URL').fill('webcal://calendar.example/timeout.ics');
  await dialog.getByRole('button', { name: 'Dodaj źródło' }).click();
  await expect(dialog.getByText('NiedostepnyICS')).toBeVisible();
  await page.waitForTimeout(1000);
  expect(refreshCount).toBe(2);
});

test('week and work-week render timed overlap geometry and work-hour boundaries', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop time-grid contract');
  await fixtureApi;
  await page.route('**/api/calendar/events**', route => {
    const from = new Date(new URL(route.request().url()).searchParams.get('from'));
    const day = new Date(from); day.setDate(day.getDate() + 2);
    const local = (hours, minutes = 0) => `${day.toISOString().slice(0, 10)}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
    return route.fulfill({ json: { events: [
      { id: 'timed-a', calendar_id: 'calendar-personal', summary: 'Timed A', starts_at: local(9), ends_at: local(11), all_day: false, source: 'local' },
      { id: 'timed-b', calendar_id: 'calendar-personal', summary: 'Timed B', starts_at: local(10), ends_at: local(12), all_day: false, source: 'local' },
      { id: 'all-day', calendar_id: 'calendar-personal', summary: 'All day', starts_at: `${day.toISOString().slice(0, 10)}T00:00:00.000Z`, ends_at: `${new Date(day.getTime() + 86400000).toISOString().slice(0, 10)}T00:00:00.000Z`, all_day: true, source: 'local' },
    ] } });
  });
  await page.goto('/?list=0&reader=0');
  await page.getByTestId('calendar-nav-primary').click();
  await page.getByTestId('calendar-view-week').click();
  const grid = page.getByTestId('calendar-grid');
  await expect(grid.getByTestId('calendar-work-hours-boundary')).toHaveCount(7);
  const first = grid.getByRole('button', { name: /Timed A/ }).first();
  const second = grid.getByRole('button', { name: /Timed B/ }).first();
  const [firstBox, secondBox] = await Promise.all([first.boundingBox(), second.boundingBox()]);
  expect(firstBox.y).toBeLessThan(secondBox.y);
  expect(firstBox.x + firstBox.width).toBeLessThanOrEqual(secondBox.x + secondBox.width);
  await expect(grid.getByText('All day', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/calendar-week-time-grid-desktop.png', fullPage: true });
  await page.getByTestId('calendar-view-workweek').click();
  await expect(grid.getByTestId('calendar-work-hours-boundary')).toHaveCount(5);
  await page.screenshot({ path: 'artifacts/calendar-workweek-time-grid-desktop.png', fullPage: true });
});

test('work-week entry re-anchors time-grid scrolling while same-view navigation preserves it', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop time-grid scroll policy');
  await fixtureApi;
  await page.goto('/?list=0&reader=0');
  await page.getByTestId('calendar-nav-primary').click();
  await page.getByTestId('calendar-view-week').click();
  const scroller = page.getByTestId('calendar-time-grid-scroll');
  await scroller.evaluate(element => { element.scrollTop = 777; });
  await page.getByTestId('calendar-view-workweek').click();
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(420);
  await scroller.evaluate(element => { element.scrollTop = 555; });
  await page.getByRole('button', { name: 'Następny okres', exact: true }).click();
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(555);
});

test('remote source panel surfaces listSources failures', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop source management contract');
  await fixtureApi;
  await page.route('**/api/calendar/sources**', route => route.fulfill({ status: 503, json: { error: 'source list unavailable' } }));
  await page.goto('/?list=0&reader=0');
  await page.getByTestId('calendar-nav-primary').click();
  await page.getByTestId('calendar-sidebar-manage-sources').click();
  const dialog = page.getByRole('dialog', { name: 'Zarządzaj źródłami' });
  await expect(dialog.getByRole('alert')).toContainText('source list unavailable');
  await expect(dialog.getByText('Gotowe')).toHaveCount(0);
});

for (const [outcome, response] of [
  ['resolve', { status: 200, json: { sources: [{ id: 'late-source', displayName: 'Late source', kind: 'ical_url' }] } }],
  ['reject', { status: 503, json: { error: 'late source failure' } }],
]) {
  test(`source panel ignores delayed listSources ${outcome} after navigation`, async ({ page, fixtureApi }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop source panel lifecycle contract');
    await fixtureApi;
    let release;
    const delayed = new Promise(resolve => { release = resolve; });
    await page.route('**/api/calendar/sources**', async route => { await delayed; return route.fulfill(response); });
    await page.goto('/?list=0&reader=0');
    await page.getByTestId('calendar-nav-primary').click();
    await page.getByTestId('calendar-sidebar-manage-sources').click();
    await page.reload();
    release();
    await page.waitForTimeout(100);
    await expect(page.getByText(response.json.sources ? 'Late source' : 'late source failure')).toHaveCount(0);
  });
}

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

test('calendar event menus support desktop keyboard and mobile invocation while filtering read-only actions', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const day = new Date().toISOString().slice(0, 10);
  await page.route('**/api/calendar/events**', route => route.fulfill({ json: { events: [
    { id: 'local-event', calendar_id: 'calendar-personal', summary: 'Local planning', starts_at: `${day}T10:00:00.000Z`, ends_at: `${day}T11:00:00.000Z`, source: 'local', read_only: false },
    { id: 'remote-event', calendar_id: 'calendar-personal', summary: 'Imported meeting', starts_at: `${day}T12:00:00.000Z`, ends_at: `${day}T13:00:00.000Z`, source: 'ical', read_only: true },
  ] } }));
  await page.goto('/');
  const calendar = page.viewportSize().width < 768
    ? page.getByTestId('mobile-primary-nav').getByRole('button', { name: 'Kalendarz' })
    : page.getByTestId('calendar-nav-primary');
  await calendar.click();
  const local = page.getByRole('button', { name: /Local planning/ });
  const imported = page.getByRole('button', { name: /Imported meeting/ });
  await expect(local).toBeVisible();
  await expect(imported).toBeVisible();
  if (page.viewportSize().width < 768) await page.getByTestId('calendar-event-actions').first().click();
  else await local.click({ button: 'right' });
  const menu = page.getByTestId('calendar-context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Edytuj wydarzenie' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Usuń' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  if (page.viewportSize().width >= 768) await expect(local).toBeFocused();
  else await expect(page.getByTestId('calendar-event-actions').first()).toBeFocused();
  if (page.viewportSize().width < 768) await page.getByTestId('calendar-event-actions').first().click();
  if (page.viewportSize().width >= 768) {
    await local.focus();
    await page.keyboard.press('Shift+F10');
    await expect(menu).toBeVisible();
  }
  if (page.viewportSize().width >= 768) {
    const box = await menu.boundingBox();
    const viewport = page.viewportSize();
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByTestId('calendar-context-delete')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(menu.getByTestId('calendar-context-delete')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(menu.getByTestId('calendar-context-delete')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Edytuj wydarzenie' })).toBeVisible();
    await page.getByRole('dialog', { name: 'Edytuj wydarzenie' }).getByRole('button', { name: 'Anuluj' }).click();
    await local.focus();
    await page.keyboard.press('Shift+F10');
    await page.keyboard.press('End');
    page.once('dialog', dialog => dialog.accept());
    await page.keyboard.press('Space');
    await expect(menu).toBeHidden();
  } else {
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByTestId('calendar-context-delete')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Edytuj wydarzenie' })).toBeVisible();
    await page.getByRole('dialog', { name: 'Edytuj wydarzenie' }).getByRole('button', { name: 'Anuluj' }).click();
    await page.getByTestId('calendar-event-actions').first().click();
    await page.keyboard.press('End');
    page.once('dialog', dialog => dialog.accept());
    await page.keyboard.press('Space');
    await expect(menu).toBeHidden();
  }
  if (page.viewportSize().width >= 768) {
    await imported.focus();
    await page.keyboard.press('Shift+F10');
  } else await page.getByTestId('calendar-event-actions').nth(1).click();
  const readOnlyMenu = page.getByTestId('calendar-context-menu');
  await expect(readOnlyMenu).toBeVisible();
  await expect(readOnlyMenu.getByTestId('calendar-context-read-only')).toBeVisible();
  await expect(readOnlyMenu.getByRole('menuitem')).toHaveCount(0);
  await page.getByRole('button', { name: 'Zamknij menu kalendarza' }).click();
  await expect(readOnlyMenu).toBeHidden();
  if (page.viewportSize().width >= 768) await expect(imported).toBeFocused();
  else await expect(page.getByTestId('calendar-event-actions').nth(1)).toBeFocused();
});

test('week and work-week time-grid events expose menus for timed and all-day events', async ({ page, fixtureApi }, testInfo) => {
  await fixtureApi;
  let date;
  await page.route('**/api/calendar/events**', route => {
    const from = new Date(new URL(route.request().url()).searchParams.get('from'));
    const localKey = value => [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
    date = localKey(from);
    return route.fulfill({ json: { events: [
    { id: 'grid-timed-local', calendar_id: 'calendar-personal', summary: 'Grid timed local', starts_at: `${date}T10:00:00.000Z`, ends_at: `${date}T11:00:00.000Z`, source: 'local', read_only: false },
    { id: 'grid-all-day-local', calendar_id: 'calendar-personal', summary: 'Grid all-day local', starts_at: '2026-01-01T00:00:00.000Z', ends_at: '2027-01-01T00:00:00.000Z', all_day: true, source: 'local', read_only: false },
    { id: 'grid-timed-remote', calendar_id: 'calendar-personal', summary: 'Grid timed remote', starts_at: `${date}T12:00:00.000Z`, ends_at: `${date}T13:00:00.000Z`, source: 'ical', read_only: true },
    { id: 'grid-all-day-remote', calendar_id: 'calendar-personal', summary: 'Grid all-day remote', starts_at: '2026-01-01T00:00:00.000Z', ends_at: '2027-01-01T00:00:00.000Z', all_day: true, source: 'ical', read_only: true },
    ] } });
  });
  await page.goto('/');
  const calendar = page.viewportSize().width < 768
    ? page.getByTestId('mobile-primary-nav').getByRole('button', { name: 'Kalendarz' })
    : page.getByTestId('calendar-nav-primary');
  await calendar.click();
  for (const view of ['week', 'workweek']) {
    await page.getByTestId(`calendar-view-${view}`).click();
    const grid = page.getByTestId('calendar-grid');
    await expect(grid.getByRole('button', { name: /Grid timed local/ })).toBeVisible();
    const allDayLocal = grid.getByRole('button', { name: /Grid all-day local/ }).first();
    await expect(allDayLocal).toBeVisible();
    if (page.viewportSize().width < 768) {
      const action = allDayLocal.locator('..').getByTestId('calendar-event-actions');
      expect((await action.boundingBox()).width).toBeGreaterThanOrEqual(44);
      await action.click();
    } else {
      await grid.getByRole('button', { name: /Grid timed local/ }).click({ button: 'right' });
    }
    const menu = page.getByTestId('calendar-context-menu');
    await expect(menu.getByRole('menuitem')).toHaveCount(2);
    await page.keyboard.press('Escape');
    if (page.viewportSize().width >= 768) {
      await grid.getByRole('button', { name: /Grid all-day remote/ }).first().press('Shift+F10');
    } else {
      await grid.getByRole('button', { name: /Grid all-day remote/ }).first().locator('..').getByTestId('calendar-event-actions').click();
    }
    await expect(page.getByTestId('calendar-context-read-only')).toBeVisible();
    await expect(page.getByTestId('calendar-context-menu').getByRole('menuitem')).toHaveCount(0);
    await page.keyboard.press('Escape');
  }
  await page.screenshot({ path: testInfo.outputPath('calendar-time-grid-menus.png'), fullPage: true });
});

test('mobile week and work-week timed events expose writable and read-only actions', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-mobile-390', 'chromium-mobile'].includes(testInfo.project.name), 'mobile timed-event actions');
  await fixtureApi;
  await page.route('**/api/calendar/events**', route => {
    const from = new Date(new URL(route.request().url()).searchParams.get('from'));
    const day = new Date(from); day.setDate(day.getDate() + 2);
    const date = day.toISOString().slice(0, 10);
    return route.fulfill({ json: { events: [
      { id: 'mobile-timed-local', calendar_id: 'calendar-personal', summary: 'Mobile timed local', starts_at: `${date}T10:00:00.000Z`, ends_at: `${date}T11:00:00.000Z`, source: 'local', read_only: false },
      { id: 'mobile-timed-remote', calendar_id: 'calendar-personal', summary: 'Mobile timed remote', starts_at: `${date}T12:00:00.000Z`, ends_at: `${date}T13:00:00.000Z`, source: 'ical', read_only: true },
    ] } });
  });
  await page.goto('/');
  await page.getByTestId('mobile-primary-nav').getByRole('button', { name: 'Kalendarz' }).click();
  const grid = page.getByTestId('calendar-grid');
  for (const view of ['week', 'workweek']) {
    await page.getByTestId(`calendar-view-${view}`).click();
    const local = grid.getByRole('button', { name: /Mobile timed local/ });
    const remote = grid.getByRole('button', { name: /Mobile timed remote/ });
    const localActions = local.locator('..').getByTestId('calendar-event-actions');
    const remoteActions = remote.locator('..').getByTestId('calendar-event-actions');
    await expect(localActions).toBeVisible();
    await expect(remoteActions).toBeVisible();
    expect((await localActions.boundingBox()).width).toBeGreaterThanOrEqual(44);
    expect((await localActions.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect((await remoteActions.boundingBox()).width).toBeGreaterThanOrEqual(44);
    expect((await remoteActions.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await localActions.click();
    const menu = page.getByTestId('calendar-context-menu');
    await expect(menu.getByRole('menuitem')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await remoteActions.click();
    await expect(page.getByTestId('calendar-context-read-only')).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveCount(0);
    await page.keyboard.press('Escape');
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

for (const theme of [undefined, 'dark']) {
test(`Contacts destructive controls expose responsive danger states${theme ? ` in ${theme} theme` : ' with custom CSS'}`, async ({ page, fixtureApi }) => {
  if (theme) page.__themeOverride = theme;
  await fixtureApi;
  await page.route('**/api/auth/preferences**', route => route.fulfill({ json: {
    language: 'pl', theme: theme || 'light', threadedView: true,
    conversation_list_view_enabled: true, conversation_reader_view_enabled: true,
    block_remote_images: true,
    customCss: ':root { --contacts-danger-disabled-bg: transparent; }',
  } }));
  let releaseDelete;
  let deleteCount = 0;
  await page.route('**/api/contacts**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'DELETE') {
      deleteCount += 1;
      await new Promise(resolve => { releaseDelete = resolve; });
      return route.fulfill({ json: { ok: true } });
    }
    if (pathname.endsWith('/contact-danger')) {
      return route.fulfill({ json: {
        id: 'contact-danger', display_name: 'Danger Contact', primary_email: 'danger@example.test',
        emails: [{ value: 'danger@example.test', type: 'work' }],
        phones: [{ value: '+1 555 0100', type: 'mobile' }],
        urls: [{ value: 'https://example.test', type: 'other' }],
      } });
    }
    return route.fulfill({ json: {
      contacts: [{ id: 'contact-danger', display_name: 'Danger Contact', primary_email: 'danger@example.test' }], total: 1,
    } });
  });
  await page.goto('/?list=0&reader=0');
  const navigation = page.getByTestId('mobile-primary-nav');
  if (page.viewportSize().width < 768) await navigation.getByRole('button', { name: 'Kontakty' }).click();
  else await page.getByTestId('contacts-nav-primary').click();
  await page.getByText('Danger Contact', { exact: true }).click();

  await page.getByRole('button', { name: 'Edytuj' }).click();
  await expect(page.locator('.contacts-danger-btn[aria-label]')).toHaveCount(2);
  await expect(page.locator('.contacts-danger-btn[aria-label]').first()).toHaveAttribute('aria-label', /Usuń .+ 1/);
  await page.getByRole('button', { name: 'Anuluj' }).press('Enter');

  const deleteButton = page.getByRole('button', { name: 'Usuń' }).first();
  await expect(deleteButton).toHaveClass(/contacts-danger-btn/);
  await deleteButton.hover();
  const hoverState = await deleteButton.evaluate(button => {
    const style = getComputedStyle(button);
    return { background: style.backgroundColor, border: style.borderColor };
  });
  expect(hoverState.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(hoverState.border).not.toBe('');
  await deleteButton.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const focusState = await deleteButton.evaluate(button => {
    const style = getComputedStyle(button);
    return { outline: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
  expect(focusState.outline).toBe('solid');
  expect(focusState.width).toBeGreaterThanOrEqual(2);
  await deleteButton.click();

  const confirmButton = page.getByTestId('contacts-delete-confirmation').locator('.contacts-danger-btn');
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();
  await expect(confirmButton).toBeDisabled();
  const disabledState = await confirmButton.evaluate(button => {
    const style = getComputedStyle(button);
    return {
      background: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      border: style.borderColor,
      borderWidth: style.borderTopWidth,
      color: style.color,
      cursor: style.cursor,
      opacity: style.opacity,
      transitionDuration: style.transitionDuration,
    };
  });
  expect(disabledState.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(disabledState.backgroundImage).toContain('linear-gradient');
  expect(disabledState.backgroundImage).toContain('rgba(0, 0, 0, 0)');
  expect(disabledState.border).not.toBe('');
  expect(disabledState.borderWidth).toBe('1px');
  expect(disabledState.color).not.toBe('rgba(0, 0, 0, 0)');
  expect(disabledState.cursor).toBe('not-allowed');
  expect(Number(disabledState.opacity)).toBeLessThan(1);
  expect(disabledState.transitionDuration).toBe('0s');
  expect(await confirmButton.getAttribute('aria-label')).toBeNull();
  await expect.poll(() => deleteCount).toBe(1);
  await confirmButton.click({ force: true });
  expect(deleteCount).toBe(1);
  releaseDelete();
  await expect(page.locator('.contacts-danger-btn').filter({ hasText: 'Usuń' })).toHaveCount(0);
});
}

for (const theme of ['win9x', 'winxp']) {
  test(`Contacts danger contract survives ${theme} theme`, async ({ page, fixtureApi }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'retro theme danger contract is a desktop regression');
    page.__themeOverride = theme;
    await fixtureApi;
    let releaseDelete;
    let deleteCount = 0;
    await page.route('**/api/contacts**', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (request.method() === 'DELETE') {
        deleteCount += 1;
        await new Promise(resolve => { releaseDelete = resolve; });
        return route.fulfill({ json: { ok: true } });
      }
      if (pathname.endsWith('/contact-danger')) {
        return route.fulfill({ json: {
          id: 'contact-danger', display_name: 'Danger Contact', primary_email: 'danger@example.test',
          emails: [{ value: 'danger@example.test', type: 'work' }],
        } });
      }
      return route.fulfill({ json: {
        contacts: [{ id: 'contact-danger', display_name: 'Danger Contact', primary_email: 'danger@example.test' }], total: 1,
      } });
    });
    await page.goto('/?list=0&reader=0');
    await page.getByTestId('contacts-nav-primary').click();
    await page.getByText('Danger Contact', { exact: true }).click();
    await page.getByRole('button', { name: 'Edytuj' }).click();
    await page.getByRole('button', { name: 'Anuluj' }).press('Enter');

    const deleteButton = page.getByRole('button', { name: 'Usuń' }).first();
    await deleteButton.hover();
    const hoverState = await deleteButton.evaluate(button => {
      const style = getComputedStyle(button);
      return { background: style.backgroundColor, borderWidth: style.borderTopWidth };
    });
    expect(hoverState.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(hoverState.borderWidth).toBe('1px');
    await deleteButton.focus();
    const focusState = await deleteButton.evaluate(button => {
      const style = getComputedStyle(button);
      return { outline: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(focusState.outline).toBe('solid');
    expect(focusState.width).toBeGreaterThanOrEqual(2);
    await deleteButton.click();

    const confirmButton = page.getByTestId('contacts-delete-confirmation').locator('.contacts-danger-btn');
    await confirmButton.click();
    await expect(confirmButton).toBeDisabled();
    const disabledState = await confirmButton.evaluate(button => {
      const style = getComputedStyle(button);
      return { background: style.backgroundColor, borderWidth: style.borderTopWidth };
    });
    expect(disabledState.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(disabledState.borderWidth).toBe('1px');
    expect(await confirmButton.getAttribute('disabled')).not.toBeNull();
    await expect.poll(() => deleteCount).toBe(1);
    releaseDelete();
  });
}

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
