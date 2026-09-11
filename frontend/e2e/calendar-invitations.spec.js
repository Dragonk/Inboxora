import { test, expect } from './fixtures.js';
import { setupV3, navigateModule } from './v3-fixtures.js';

for (const reader of [false, true]) test(`mail invitation can be added from ${reader ? 'conversation' : 'single'} reader`, async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-mobile-390', 'chromium-desktop'].includes(testInfo.project.name), 'reader coverage');
  await fixtureApi; await setupV3(page); page.__conversationMatrix = `0${Number(reader)}`;
  const additions = [];
  await page.route('**/api/mail/messages/*/body**', route => route.fulfill({ json: { html: '<p>Invitation message</p>', text: 'Invitation message', calendarInvitation: true, attachments: [] } }));
  await page.route('**/api/calendar/invitations/*', route => {
    if (route.request().method() === 'POST') { additions.push(route.request().postDataJSON()); return route.fulfill({ json: { added: true } }); }
    return route.fulfill({ json: { invitation: { method: 'REQUEST', summary: 'Planowanie z maila', description: 'Pierwsza linia\nDruga linia', location: 'Biuro', startsAt: '2026-09-10T09:00:00Z', endsAt: '2026-09-10T10:00:00Z' } } });
  });
  await page.goto('/');
  await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
  if (reader) {
    const card = page.locator('[data-message-detail-content]:visible').first();
    if (!await card.count()) await page.locator('[data-conversation-message-toggle]').first().click();
  }
  const invitation = page.getByTestId('calendar-invitation-card').filter({ visible: true }).first();
  // The panel is a single compact action row: the message itself already shows the title
  // above and the body below, so only the date, the calendar and the action belong here.
  // The title and description must NOT be repeated inside the panel.
  await expect(invitation).toContainText('Zaproszenie do kalendarza');
  await expect(invitation.getByTestId('calendar-invitation-when')).toContainText('10 wrz 2026');
  await expect(invitation).not.toContainText('Planowanie z maila');
  await expect(invitation).not.toContainText('Pierwsza linia');
  await expect(invitation.locator('iframe')).toHaveCount(0);
  await invitation.getByRole('button', { name: 'Dodaj do kalendarza', exact: true }).click();
  await expect(invitation.getByRole('status')).toHaveText('Dodano do kalendarza');
  expect(additions).toEqual([{ calendarId: 'calendar-personal' }]);
  await page.screenshot({ path: testInfo.outputPath('invitation-added.png') });
});

test('an added invitation reports the copy and can withdraw it again', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'reader coverage');
  await fixtureApi; await setupV3(page); page.__conversationMatrix = '00';
  const removals = [];
  await page.route('**/api/mail/messages/*/body**', route => route.fulfill({ json: { html: '<p>Invitation message</p>', text: '', calendarInvitation: true, attachments: [] } }));
  await page.route('**/api/calendar/invitations/*', route => {
    if (route.request().method() === 'DELETE') { removals.push(route.request().url()); return route.fulfill({ json: { removed: true } }); }
    // The server reports that this message already created a local event.
    return route.fulfill({ json: { invitation: {
      method: 'REQUEST', summary: 'Planowanie z maila', startsAt: '2026-09-10T09:00:00Z', endsAt: '2026-09-10T10:00:00Z',
      localEvent: { id: 'event-1', calendarId: 'calendar-personal', sequence: 0 },
    } } });
  });
  await page.goto('/');
  await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
  const invitation = page.getByTestId('calendar-invitation-card').filter({ visible: true }).first();
  // A reload must show the invitation as already added, not offer to add it twice.
  await expect(invitation.getByRole('status')).toHaveText('Już w kalendarzu');
  await expect(invitation.getByRole('button', { name: 'Dodaj do kalendarza', exact: true })).toHaveCount(0);
  await invitation.getByRole('button', { name: 'Usuń z kalendarza', exact: true }).click();
  await expect(invitation.getByRole('button', { name: 'Dodaj do kalendarza', exact: true })).toBeVisible();
  expect(removals).toHaveLength(1);
});

test('a cancelled invitation is actionable and withdraws the added copy', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'reader coverage');
  await fixtureApi; await setupV3(page); page.__conversationMatrix = '00';
  const removals = [];
  await page.route('**/api/mail/messages/*/body**', route => route.fulfill({ json: { html: '<p>Cancelled invitation</p>', text: '', calendarInvitation: true, attachments: [] } }));
  await page.route('**/api/calendar/invitations/*', route => {
    if (route.request().method() === 'DELETE') { removals.push(route.request().url()); return route.fulfill({ json: { removed: true } }); }
    return route.fulfill({ json: { invitation: {
      method: 'CANCEL', summary: 'Planowanie z maila', startsAt: '2026-09-10T09:00:00Z', endsAt: '2026-09-10T10:00:00Z',
      localEvent: { id: 'event-1', calendarId: 'calendar-personal', sequence: 0 },
    } } });
  });
  await page.goto('/');
  await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
  const invitation = page.getByTestId('calendar-invitation-card').filter({ visible: true }).first();
  // A cancellation must not offer to add the event; it offers to remove the copy it made.
  await expect(invitation).toContainText('Wydarzenie anulowane');
  await expect(invitation.getByRole('button', { name: 'Dodaj do kalendarza', exact: true })).toHaveCount(0);
  await invitation.getByRole('button', { name: 'Usuń z kalendarza', exact: true }).click();
  // Once the copy is gone there is nothing left to withdraw, so the panel falls back to the
  // plain explanation of the cancellation.
  await expect(invitation.getByRole('status')).toHaveText('Organizator anulował to wydarzenie.');
  await expect(invitation.getByRole('button', { name: 'Usuń z kalendarza', exact: true })).toHaveCount(0);
  expect(removals).toHaveLength(1);
});

test('a cancelled invitation that was never added explains itself without an action', async ({ page, fixtureApi }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'reader coverage');
  await fixtureApi; await setupV3(page); page.__conversationMatrix = '00';
  await page.route('**/api/mail/messages/*/body**', route => route.fulfill({ json: { html: '<p>Cancelled invitation</p>', text: '', calendarInvitation: true, attachments: [] } }));
  await page.route('**/api/calendar/invitations/*', route => route.fulfill({ json: { invitation: {
    method: 'CANCEL', summary: 'Planowanie z maila', startsAt: '2026-09-10T09:00:00Z', localEvent: null,
  } } }));
  await page.goto('/');
  await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
  const invitation = page.getByTestId('calendar-invitation-card').filter({ visible: true }).first();
  await expect(invitation).toContainText('Organizator anulował to wydarzenie');
  await expect(invitation.getByRole('button')).toHaveCount(0);
});

test('imported event preview exposes description, participants and safe meeting link', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-mobile-390', 'chromium-desktop'].includes(testInfo.project.name), 'event metadata');
  await fixtureApi; await setupV3(page);
  await page.route('**/api/calendar/events**', route => route.fulfill({ json: { events: [{ id: 'metadata', calendar_id: 'calendar-remote', source: 'caldav', read_only: true, summary: 'Pełne wydarzenie', description: 'Plan\nSzczegóły', location: 'Sala 2', organizer: 'team@example.test', attendees: ['jane@example.test'], url: 'https://example.test/join', starts_at: '2026-09-10T09:00:00Z', ends_at: '2026-09-10T10:00:00Z' }] } }));
  await page.goto('/'); await navigateModule(page, 'calendar');
  await page.getByRole('button', { name: /Pełne wydarzenie/ }).first().click();
  const preview = page.getByTestId('calendar-event-preview');
  // Description copy is rendered by the message-body iframe, not as DOM text.
  await expect(preview.getByTestId('calendar-event-description-body').frameLocator('iframe').locator('body')).toContainText('Szczegóły');
  await expect(preview).toContainText('jane@example.test');
  await expect(preview.getByRole('link')).toHaveAttribute('href', 'https://example.test/join');
  await page.screenshot({ path: testInfo.outputPath('event-metadata.png') });
});

test('editing a recurring occurrence uses its series identity and preserves participants', async ({ page, fixtureApi }, testInfo) => {
  test.skip(!['chromium-mobile-390', 'chromium-desktop'].includes(testInfo.project.name), 'occurrence editor');
  await fixtureApi; await setupV3(page);
  const edits = [];
  await page.route('**/api/calendar/events**', route => {
    if (route.request().method() === 'PATCH') { edits.push({ url: route.request().url(), body: route.request().postDataJSON() }); return route.fulfill({ json: { updated: true } }); }
    return route.fulfill({ json: { events: [{ id: 'series@2026-09-10T09:00:00', series_id: 'series', recurring: true, recurrence_id: '2026-09-10T09:00:00', calendar_id: 'calendar-personal', source: 'local', read_only: false, summary: 'Cykliczne spotkanie', description: 'Agenda', attendees: ['jane@example.test'], starts_at: '2026-09-10T09:00:00Z', ends_at: '2026-09-10T10:00:00Z' }] } });
  });
  await page.goto('/'); await navigateModule(page, 'calendar');
  await page.getByRole('button', { name: /Cykliczne spotkanie/ }).first().click();
  // Opening an event shows the mail-like preview first; editing is one tap away.
  const preview = page.getByTestId('calendar-event-preview');
  await expect(preview).toBeVisible();
  await page.getByTestId('calendar-preview-edit').click();
  const editor = page.getByTestId('calendar-event-dialog');
  await expect(editor).toContainText('tylko to wystąpienie');
  await editor.getByLabel('Tytuł', { exact: true }).fill('Przeniesione spotkanie');
  await editor.getByRole('button', { name: 'Zapisz', exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(edits[0].url).toContain('/calendar/events/series/occurrence');
  expect(edits[0].body).toMatchObject({ recurrenceId: '2026-09-10T09:00:00', attendees: ['jane@example.test'] });
});
