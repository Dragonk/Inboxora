import { test, expect, type Page } from '@playwright/test';
import { bootQueue, enterQueue, queueMessage, queueRow, queueServer } from './scheduled-view-fixtures.ts';

test.use({ serviceWorkers: 'block', timezoneId: 'Europe/Warsaw' });

/** A fixed 02:44 local time, with delivery due at 02:45; no external mail service is contacted. */
async function startBeforeDeadline(page: Page) {
  await page.clock.install({ time: new Date('2030-01-15T01:44:00Z') });
  const server = queueServer([queueRow('deadline', { state: 'pending', scheduledAt: '2030-01-15T01:45:00Z' })]);
  await bootQueue(page, server);
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 1000)));
  await enterQueue(page);
  await page.getByTestId('scheduled-item-deadline').getByRole('button').click();
  return server;
}

/** Choose a local wall time through the same fields available to the user. */
async function time(page: Page, date: string, hour: string, minute: string) {
  await page.getByTestId('schedule-date').fill(date);
  await page.getByTestId('schedule-hour').selectOption(hour);
  await page.getByTestId('schedule-minute').selectOption(minute);
}

test('confirmed cancellation removes list and preview immediately even when subsequent refresh fails', async ({ page }) => {
  const server = queueServer([
    queueRow('cancel', { state: 'pending', scheduledAt: '2030-01-15T12:45:00Z' }),
    queueRow('keep', { state: 'editing', subject: 'Keep this paused message' }),
  ]);
  await bootQueue(page, server); await enterQueue(page);
  await page.getByTestId('scheduled-item-cancel').getByRole('button').click();
  await expect(page.getByTestId('scheduled-preview')).toBeVisible();
  server.failList = true;
  await page.getByTestId('scheduled-cancel-cancel').click();
  await page.getByTestId('scheduled-confirmation').getByRole('button', { name: 'Cancel delivery', exact: true }).click();
  await expect(page.getByTestId('scheduled-item-cancel')).toHaveCount(0);
  await expect(page.getByTestId('scheduled-preview')).toHaveCount(0);
  await expect(page.getByTestId('scheduled-item-keep')).toBeVisible();
  expect(server.rows.find(row => row.id === 'cancel')?.state).toBe('cancelled');
  expect(server.mutations.map(mutation => mutation.action)).toEqual(['cancel']);
  server.failList = false;
  await page.getByTestId('scheduled-refresh').click();
  await expect(page.getByTestId('scheduled-item-cancel')).toHaveCount(0);
  await page.reload(); await enterQueue(page);
  await expect(page.getByTestId('scheduled-item-cancel')).toHaveCount(0);
  await expect(page.getByTestId('scheduled-item-keep')).toBeVisible();
  expect(server.sendCalls).toBe(0);
});

test('a worker winning cancellation keeps the sending entry visible and does not claim recall', async ({ page }) => {
  const server = await startBeforeDeadline(page);
  await page.route('**/api/mail/scheduled/deadline/cancel', route => {
    server.rows[0].state = 'sending';
    return route.fulfill({ status: 409, json: { code: 'SCHEDULE_CHANGED', error: 'Submission already started' } });
  });
  await page.getByTestId('scheduled-cancel-deadline').click();
  await page.getByTestId('scheduled-confirmation').getByRole('button', { name: 'Cancel delivery', exact: true }).click();
  await expect(page.getByTestId('scheduled-item-deadline')).toContainText('Sending');
  await expect(page.getByTestId('scheduled-view').getByRole('alert')).toContainText('delivery has started');
  await expect(page.getByTestId('scheduled-cancel-deadline')).toHaveCount(0);
  expect(server.sendCalls).toBe(0);
});

test('editing at 02:44 remains paused after 02:45 and autosaves until explicitly scheduled again', async ({ page }) => {
  const server = await startBeforeDeadline(page);
  const writes: Array<Record<string, unknown>> = [];
  await page.route('**/api/mail/scheduled/deadline', route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    writes.push(body);
    expect(body.revision).toBe(server.rows[0].revision);
    server.rows[0].revision++;
    server.rows[0].state = body.keepEditing === true ? 'editing' : 'pending';
    if (typeof body.scheduledAt === 'string') server.rows[0].scheduledAt = body.scheduledAt;
    return route.fulfill({ json: server.rows[0] });
  });
  await page.getByTestId('scheduled-edit-deadline').click();
  await expect(page.getByTestId('compose-queue-paused')).toBeVisible();
  await expect.poll(() => server.rows[0].state).toBe('editing');
  await page.clock.runFor(100);
  const editor = page.locator('.tiptap-compose [contenteditable="true"]');
  await editor.fill('Revised after pausing');
  await page.clock.fastForward(120_000);
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ revision: 1, keepEditing: true, message: {
    body: '<p>Revised after pausing</p>', inReplyTo: queueMessage.inReplyTo,
    references: queueMessage.references, aliasId: queueMessage.aliasId,
    attachments: queueMessage.attachments, editedSignature: queueMessage.editedSignature,
  } });
  expect(server.rows[0].state).toBe('editing');
  expect(server.sendCalls).toBe(0);
  await editor.fill('Final message after the original deadline');
  await page.clock.fastForward(30_000);
  await expect.poll(() => writes.length).toBe(2);
  expect(writes.every(write => write.keepEditing === true)).toBe(true);
  expect(server.rows[0].state).toBe('editing');
  await page.getByTestId('compose-send-menu').click();
  await page.getByTestId('compose-schedule').click();
  await expect(page.getByTestId('schedule-confirm')).toBeDisabled();
  await time(page, '2030-01-15', '03', '00');
  await page.getByTestId('schedule-confirm').click();
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2]).toMatchObject({ revision: 3, scheduledAt: '2030-01-15T02:00:00.000Z', message: {
    body: '<p>Final message after the original deadline</p>', inReplyTo: queueMessage.inReplyTo,
    references: queueMessage.references, attachments: queueMessage.attachments,
  } });
  expect(writes[2]).not.toHaveProperty('keepEditing');
  await expect(page.getByTestId('compose-from')).toHaveCount(0);
  expect(server.rows[0].state).toBe('pending');
  expect(server.sendCalls).toBe(0);
});

for (const mode of ['new', 'reschedule'] as const) {
  test(`${mode}: past days, earlier hours and a deadline expiring in the open dialog cannot be submitted`, async ({ page }) => {
    const server = await startBeforeDeadline(page);
    const accepted: Record<string, unknown>[] = [];
    if (mode === 'reschedule') await page.getByTestId('scheduled-reschedule-deadline').click();
    else {
      // Open a separate authored message; the existing queue is not mutated.
      if ((page.viewportSize()?.width ?? 1280) < 768) await page.getByTestId('mobile-topbar-menu').click();
      await page.getByTestId('all-inboxes').click();
      await page.getByRole('button', { name: 'Compose', exact: true }).first().click();
      await page.getByTestId('compose-to').fill('taylor@example.test');
      await page.getByPlaceholder(/^(Add a subject|Subject)$/).fill('Future send');
      await page.locator('.tiptap-compose [contenteditable="true"]').fill('Only send at a future time.');
      await page.getByTestId('compose-send-menu').click(); await page.getByTestId('compose-schedule').click();
      await page.route(/\/api\/mail\/scheduled(?:\?.*)?$/, route => {
        if (route.request().method() === 'GET') return route.fallback();
        accepted.push(route.request().postDataJSON());
        return route.fulfill({ json: queueRow('new', { state: 'pending', scheduledAt: '2030-01-15T02:00:00Z' }) });
      });
    }
    await expect(page.getByTestId('schedule-date')).toHaveAttribute('min', '2030-01-15');
    for (const [date, hour, minute] of [['2030-01-14', '23', '59'], ['2030-01-15', '02', '43'], ['2030-01-15', '02', '44']]) {
      await time(page, date, hour, minute);
      await expect(page.getByTestId('schedule-confirm')).toBeDisabled();
      await expect(page.getByTestId('schedule-dialog').getByRole('alert')).toBeVisible();
      await page.getByTestId('schedule-dialog').locator('form').evaluate(form => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(accepted).toEqual([]); expect(server.mutations).toEqual([]);
    }
    await time(page, '2030-01-15', '02', '45');
    await expect(page.getByTestId('schedule-confirm')).toBeEnabled();
    await page.clock.fastForward(60_000);
    await expect(page.getByTestId('schedule-confirm')).toBeDisabled();
    expect(accepted).toEqual([]); expect(server.mutations).toEqual([]);
    await time(page, '2030-01-15', '03', '00');
    await page.getByTestId('schedule-confirm').click();
    if (mode === 'new') await expect.poll(() => accepted.length).toBe(1);
    else await expect.poll(() => server.mutations.length).toBe(1);
    const submitted = mode === 'new' ? accepted[0] : server.mutations[0].body;
    expect(submitted.scheduledAt).toBe('2030-01-15T02:00:00.000Z');
    expect(server.sendCalls).toBe(0);
  });
}

test('a server-authoritative past-time rejection keeps the schedule dialog editable with a localized error', async ({ page }) => {
  await startBeforeDeadline(page);
  await page.getByTestId('scheduled-reschedule-deadline').click();
  await time(page, '2030-01-15', '03', '00');
  await page.route('**/api/mail/scheduled/deadline', route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    return route.fulfill({ status: 400, json: { code: 'SCHEDULE_PAST', error: 'Backend deadline expired' } });
  });
  await page.getByTestId('schedule-confirm').click();
  await expect(page.getByTestId('schedule-dialog')).toBeVisible();
  await expect(page.getByTestId('schedule-dialog').getByRole('alert')).toContainText(/future/i);
  await expect(page.getByTestId('schedule-hour')).toBeEnabled();
  await expect(page.getByTestId('scheduled-item-deadline')).toHaveCount(1);
});

test('queued attachment preview is revision-scoped and does not pause or mutate the queue', async ({ page }) => {
  const server = await startBeforeDeadline(page);
  server.previewOverrides.set('deadline', { message: { ...queueMessage,
    attachments: [{ filename: 'milestones.txt', contentType: 'text/plain', size: 20 }],
  } });
  const reads: string[] = [];
  await page.route('**/api/mail/scheduled/deadline/attachments/*', route => {
    reads.push(route.request().url());
    const parameters = new URL(route.request().url()).searchParams;
    expect(parameters.get('revision')).toBe('1');
    expect(parameters.get('preview')).toBe('1');
    expect(route.request().headers()['x-requested-with']).toBe('MailFlow');
    // The real revision-scoped download reports its server-side scan decision.
    return route.fulfill({ contentType: 'text/plain', body: 'Queued preview text', headers: { 'X-Attachment-Scan': 'disabled' } });
  });
  await page.getByTestId('scheduled-refresh').click();
  await page.getByTestId('scheduled-preview').locator('[data-message-detail-attachment="0"]').click();
  const dialog = page.getByTestId('attachment-preview-dialog');
  await expect(dialog.locator('pre')).toContainText('Queued preview text');
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  expect(reads).toHaveLength(1); expect(server.mutations).toEqual([]); expect(server.sendCalls).toBe(0);
  expect(server.rows[0].state).toBe('pending');
});

test('queued attachments reuse inbox controls and dangerous-file confirmation without inbox operations or pausing', async ({ page }) => {
  const server = await startBeforeDeadline(page);
  server.previewOverrides.set('deadline', { message: { ...queueMessage,
    attachments: [
      { filename: 'milestones.txt', contentType: 'text/plain', size: 12 },
      { filename: 'program.exe', contentType: 'application/octet-stream', size: 4 },
      { filename: 'event.ics', contentType: 'text/calendar', size: 4 },
    ] } });
  const invalidInboxCalls: string[] = [];
  await page.route('**/api/mail/messages/deadline/**', route => {
    invalidInboxCalls.push(route.request().url());
    return route.fulfill({ status: 404, json: { error: 'A queue ID is not an inbox message' } });
  });
  const downloads: string[] = [];
  await page.route('**/api/mail/scheduled/deadline/attachments/*?*', route => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('revision')).toBe('1');
    expect(route.request().method()).toBe('GET');
    downloads.push(url.pathname);
    return route.fulfill({ contentType: 'application/octet-stream', body: Buffer.from('Safe fixture') });
  });
  await page.getByTestId('scheduled-refresh').click();
  const preview = page.getByTestId('scheduled-preview');
  await expect(preview.locator('[data-message-detail-content]')).toHaveCount(1);
  await expect(preview.locator('[data-message-detail-attachment]')).toHaveCount(3);
  await expect(preview.locator('[data-message-detail-download-all]')).toHaveCount(0);
  const downloaded = page.waitForEvent('download');
  await preview.locator('[data-message-detail-download="0"]').click();
  expect((await downloaded).suggestedFilename()).toBe('milestones.txt');
  expect(downloads).toEqual(['/api/mail/scheduled/deadline/attachments/0']);
  await preview.locator('[data-message-detail-download="1"]').click();
  await expect(page.getByTestId('dangerous-attachment-download-dialog')).toBeVisible();
  expect(downloads).toHaveLength(1);
  await page.getByTestId('dangerous-attachment-download-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(downloads).toHaveLength(1);
  await preview.locator('[data-message-detail-download="1"]').click();
  const confirmed = page.waitForEvent('download');
  await page.getByTestId('dangerous-attachment-download-confirm').click();
  expect((await confirmed).suggestedFilename()).toBe('program.exe');
  expect(downloads).toEqual(['/api/mail/scheduled/deadline/attachments/0', '/api/mail/scheduled/deadline/attachments/1']);
  expect(invalidInboxCalls).toEqual([]);
  expect(server.mutations).toEqual([]); expect(server.sendCalls).toBe(0); expect(server.rows[0].state).toBe('pending');
});

test('Scheduled uses the inbox list width, resize control, sender card and message-body alignment', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 768, 'paired desktop panels; mobile list/detail covered separately');
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = queueServer([queueRow('layout', { state: 'pending', scheduledAt: '2030-01-15T12:45:00Z' })]);
  await bootQueue(page, server);
  const inboxWidth = await page.getByTestId('message-list-scroll').evaluate(element => element.getBoundingClientRect().width);
  await enterQueue(page);
  const list = page.getByTestId('scheduled-list-scroll');
  expect((await list.boundingBox())?.width).toBeCloseTo(inboxWidth, 0);
  await page.getByTestId('scheduled-item-layout').getByRole('button').click();
  const preview = page.getByTestId('scheduled-preview');
  await expect(preview.locator('[data-message-detail-body] iframe')).toBeVisible();
  const left = await list.boundingBox(); const right = await preview.boundingBox();
  if (!left || !right) throw new Error('Missing mail panel geometry');
  expect(right.x).toBeGreaterThanOrEqual(left.x + left.width);
  const card = await preview.locator('.msg-card').first().boundingBox();
  const body = await preview.locator('[data-message-detail-body]').boundingBox();
  if (!card || !body) throw new Error('Missing shared message cards');
  expect(body.x).toBeCloseTo(card.x, 0); expect(body.width).toBeCloseTo(card.width, 0);
  await expect(preview.locator('[data-message-detail-attachments]')).toContainText('milestones.txt');
  await expect(page.getByTestId('scheduled-item-layout')).toContainText('alex@example.test');
  const handle = await page.getByTestId('scheduled-list-resize').boundingBox();
  if (!handle) throw new Error('Missing shared resize handle');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
  await page.mouse.down(); await page.mouse.move(handle.x + handle.width / 2 + 45, handle.y + 100, { steps: 5 }); await page.mouse.up();
  const resized = (await list.boundingBox())?.width;
  expect(resized).toBeCloseTo(inboxWidth + 45, 0);
  await page.getByTestId('all-inboxes').click();
  await expect(page.getByTestId('message-list-scroll')).toBeVisible();
  expect((await page.getByTestId('message-list-scroll').boundingBox())?.width).toBeCloseTo(resized!, 0);
  expect(server.mutations).toEqual([]); expect(server.sendCalls).toBe(0);
});

test('a blocked queue attachment cannot render or download before its warning is confirmed', async ({ page }) => {
  const server = await startBeforeDeadline(page);
  server.previewOverrides.set('deadline', { message: { ...queueMessage,
    attachments: [{ filename: 'milestones.txt', contentType: 'text/plain', size: 20 }],
  } });
  let reads = 0; let downloads = 0;
  await page.route('**/api/mail/scheduled/deadline/attachments/*', route => {
    const parameters = new URL(route.request().url()).searchParams;
    expect(parameters.get('revision')).toBe('1');
    if (parameters.get('preview') === '1') {
      reads++; return route.fulfill({ status: 422, json: { code: 'INFECTED' } });
    }
    downloads++; return route.fulfill({ contentType: 'text/plain', body: 'Queued preview text' });
  });
  await page.getByTestId('scheduled-refresh').click();
  await page.getByTestId('scheduled-preview').locator('[data-message-detail-attachment="0"]').click();
  const dialog = page.getByTestId('attachment-preview-dialog');
  await expect(dialog.getByRole('alert')).toContainText('blocked');
  await expect(dialog.locator('pre,iframe,canvas,img')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  const warning = page.getByTestId('attachment-dangerous-dialog');
  await expect(warning).toContainText('scanner has not confirmed');
  await warning.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(reads).toBe(1); expect(downloads).toBe(0);
  expect(server.mutations).toEqual([]); expect(server.sendCalls).toBe(0);
  expect(server.rows[0].state).toBe('pending');
});
