import { test, expect } from '@playwright/test';
import { bootQueue, enterQueue, leaveQueue, queueMessage, queueRow, queueServer, queueVisibility, QUEUE_ACCOUNT } from './scheduled-view-fixtures.ts';

test.use({ serviceWorkers: 'block', timezoneId: 'Europe/Warsaw' });

test('overnight Sent is acknowledged without clicking, retained through refresh and hidden on the next visit', async ({ page }) => {
  const server = queueServer([queueRow()]);
  await page.clock.install();
  await bootQueue(page, server);
  await page.clock.fastForward(12_000);
  await expect.poll(() => server.listReads).toBeGreaterThan(1); expect(server.seenCalls).toEqual([]);
  await enterQueue(page);
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    const header = page.getByTestId('mobile-topbar');
    await expect(header.getByRole('heading')).toHaveCount(1);
    await expect(header.getByRole('heading')).toHaveText('Scheduled');
    await expect(header.getByRole('button', { name: 'Unread only' })).toHaveCount(0);
  }
  const row = page.getByTestId('scheduled-item-overnight');
  await expect(row).toContainText('Sent');
  await expect.poll(() => server.seen.has('queue-owner:overnight')).toBe(true);
  expect(server.previews).toEqual([]); expect(server.mutations).toEqual([]);
  if ((page.viewportSize()?.width ?? 1280) >= 768) {
    const toggle = page.getByRole('button', { name: 'Toggle sidebar', exact: true });
    await toggle.click();
    await expect(page.getByTestId('sidebar-scheduled')).toHaveAttribute('aria-label', 'Scheduled');
    await expect(row).toBeVisible();
    await toggle.click(); await expect(row).toBeVisible();
  }
  for (let i = 0; i < 3; i++) { await page.getByTestId('scheduled-refresh').click(); await page.clock.fastForward(6_000); await expect(row).toBeVisible(); }
  await row.getByRole('button').click();
  await expect(page.getByTestId('scheduled-preview')).toContainText('The message copy is unavailable');
  if (await page.getByTestId('scheduled-back').isVisible()) await page.getByTestId('scheduled-back').click();
  await expect(row).toBeVisible();
  await leaveQueue(page); await enterQueue(page);
  await expect(row).toHaveCount(0);
  await page.reload(); await enterQueue(page);
  await expect(row).toHaveCount(0);
  expect(server.seenCalls).toEqual(['queue-owner:overnight']);
  expect(server.sendCalls).toBe(0); expect(server.mutations).toEqual([]);
});

test('offscreen sent badges and a hidden document are not acknowledged by fetches or polling', async ({ page }) => {
  const server = queueServer(Array.from({ length: 40 }, (_, index) => queueRow(`old-${index}`, {
    scheduledAt: new Date(Date.UTC(2020, 0, 15, 12, 0) - index * 60_000).toISOString(), subject: `Overnight message ${index + 1}`,
  })));
  await bootQueue(page, server); await page.clock.install();
  await queueVisibility(page, 'hidden'); await enterQueue(page); await page.clock.fastForward(15_000);
  expect(server.seenCalls).toEqual([]);
  await queueVisibility(page, 'visible');
  await expect.poll(() => server.seen.has('queue-owner:old-0')).toBe(true);
  expect(server.seen.has('queue-owner:old-39')).toBe(false);
  await page.clock.fastForward(10_000);
  expect(server.seen.has('queue-owner:old-39')).toBe(false);
  const last = page.getByTestId('scheduled-item-old-39');
  await last.scrollIntoViewIfNeeded();
  await expect.poll(() => server.seen.has('queue-owner:old-39')).toBe(true);
  await page.getByTestId('scheduled-refresh').click(); await expect(last).toBeVisible();
  expect(server.previews).toEqual([]); expect(server.mutations).toEqual([]);
});

test('a row changing to Sent while visible is observed but never disappears during that visit', async ({ page }) => {
  const server = queueServer([queueRow('transition', { state: 'pending' })]);
  await bootQueue(page, server); await enterQueue(page);
  expect(server.seenCalls).toEqual([]);
  server.rows[0].state = 'sent';
  await page.getByTestId('scheduled-refresh').click();
  await expect.poll(() => server.seen.has('queue-owner:transition')).toBe(true);
  await page.getByTestId('scheduled-refresh').click();
  await expect(page.getByTestId('scheduled-item-transition')).toContainText('Sent');
  await leaveQueue(page); await enterQueue(page);
  await expect(page.getByTestId('scheduled-item-transition')).toHaveCount(0);
});

test('failed visibility receipts remain retryable and an unsuccessful visit never loses its result', async ({ page }) => {
  const server = queueServer([queueRow()]); server.failSeen = true;
  await bootQueue(page, server); await page.clock.install(); await enterQueue(page);
  await expect(page.getByRole('alert')).toContainText('Could not save the viewed status');
  expect(server.seen.size).toBe(0);
  await page.getByTestId('scheduled-refresh').click();
  await expect(page.getByTestId('scheduled-item-overnight')).toBeVisible();
  await leaveQueue(page); await enterQueue(page);
  await expect(page.getByTestId('scheduled-item-overnight')).toBeVisible();
  server.failSeen = false;
  await page.clock.fastForward(6_000);
  await expect.poll(() => server.seen.has('queue-owner:overnight')).toBe(true);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('scheduled-item-overnight')).toBeVisible();
  await leaveQueue(page); await enterQueue(page);
  await expect(page.getByTestId('scheduled-item-overnight')).toHaveCount(0);
});

test('two open tabs keep their own visit after a durable acknowledgement and new visits no longer show the result', async ({ page, context }) => {
  const server = queueServer([queueRow()]);
  let release!: () => void; server.seenGate = new Promise<void>(resolve => { release = resolve; });
  const second = await context.newPage();
  try {
    await bootQueue(page, server); await bootQueue(second, server);
    await enterQueue(page); await enterQueue(second);
    await expect.poll(() => server.seenCalls.length).toBe(2);
    release();
    await expect.poll(() => server.seenCompleted).toBe(2);
    for (const tab of [page, second]) {
      await tab.getByTestId('scheduled-refresh').click();
      await expect(tab.getByTestId('scheduled-item-overnight')).toBeVisible();
    }
    await leaveQueue(second); await enterQueue(second);
    await expect(second.getByTestId('scheduled-item-overnight')).toHaveCount(0);
    await expect(page.getByTestId('scheduled-item-overnight')).toBeVisible();
  } finally { release(); await second.close(); }
});

test('late seen responses from an expired session cannot restore private rows in another account', async ({ page }) => {
  const server = queueServer([queueRow()]);
  let release!: () => void; server.seenGate = new Promise<void>(resolve => { release = resolve; });
  try {
    await bootQueue(page, server); await enterQueue(page);
    await expect.poll(() => server.seenCalls.length).toBe(1);
    server.expired.add('queue-owner');
    await page.getByTestId('scheduled-refresh').click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    release(); await expect.poll(() => server.seenCompleted).toBe(1);
    await expect(page.getByTestId('scheduled-view')).toHaveCount(0);
    await page.unroute('**/api/**');
    await bootQueue(page, server, { owner: 'other-owner' }); await enterQueue(page);
    await expect(page.getByTestId('scheduled-item-overnight')).toHaveCount(0);
    expect(server.seenCalls).toEqual(['queue-owner:overnight']);
  } finally { release(); }
});

test('read-only preview retains the worker state, uses actual thread sources and blocks remote and executable HTML', async ({ page }) => {
  const row = queueRow('reply', { state: 'pending', scheduledAt: '2030-01-15T12:45:00.000Z' });
  const server = queueServer([row]);
  const parent = queueMessage.replyToMessageId!;
  server.previewOverrides.set('reply', { context: [{ id: parent, accountId: QUEUE_ACCOUNT, subject: 'Atlas planning',
    fromName: 'Taylor Reed', fromEmail: 'taylor@example.test', date: '2026-09-27T12:00:00Z', snippet: 'Milestones' }],
    message: { ...queueMessage, attachments: [{ filename: 'milestones.txt', contentType: 'text/plain', size: 12 }],
      body: '<p>Safe queued reply</p><script>window.pwned=true</script><img src="https://tracker.example.test/pixel" onerror="window.pwned=true"><iframe src="https://tracker.example.test/frame"></iframe>' } });
  const external: string[] = [];
  await page.route('https://tracker.example.test/**', route => { external.push(route.request().url()); return route.abort(); });
  await bootQueue(page, server); await enterQueue(page);
  await page.getByTestId('scheduled-item-reply').getByRole('button').click();
  await expect(page.getByTestId('scheduled-preview')).toContainText('milestones.txt');
  await expect(page.frameLocator('[data-message-detail-body] iframe').getByText('Safe queued reply')).toBeVisible();
  await expect(page.locator('[data-message-detail-body] iframe')).toHaveAttribute('sandbox', 'allow-same-origin');
  expect(server.previews).toEqual(['reply']); expect(server.mutations).toEqual([]); expect(server.rows[0].state).toBe('pending');
  await page.locator('summary').filter({ hasText: 'Atlas planning' }).click();
  await expect.poll(() => server.bodyReads).toEqual([parent]);
  await expect(page.frameLocator('[data-message-detail-body] iframe').first().getByText('The real earlier message in the Atlas conversation.')).toBeVisible();
  expect(external).toEqual([]); expect(server.seenCalls).toEqual([]); expect(server.sendCalls).toBe(0);
  await page.getByTestId('scheduled-edit-reply').click();
  await expect(page.getByTestId('compose-from')).toHaveValue(`alias:work:${QUEUE_ACCOUNT}`);
  expect(server.mutations).toEqual([{ id: 'reply', action: 'edit', body: { revision: 1 } }]);
  expect(server.rows[0].state).toBe('editing');
});

test('rescheduling converts presentation to the browser zone without changing an unchanged saved instant', async ({ page }) => {
  const exact = '2030-01-15T12:45:37.123Z';
  const server = queueServer([queueRow('zone', { state: 'pending', scheduledAt: exact, timeZone: 'America/New_York' })]);
  await bootQueue(page, server); await enterQueue(page);
  await page.getByTestId('scheduled-item-zone').getByRole('button').click();
  const button = page.getByTestId('scheduled-reschedule-zone'); await button.click();
  await expect(page.getByTestId('schedule-zone')).toHaveCount(0);
  await expect(page.getByTestId('schedule-date')).toHaveValue('2030-01-15');
  await expect(page.getByTestId('schedule-hour')).toHaveValue('13');
  await expect(page.getByTestId('schedule-minute')).toHaveValue('45');
  expect(server.mutations).toEqual([]);
  await page.keyboard.press('Escape'); await expect(button).toBeFocused();
  expect(server.rows[0].scheduledAt).toBe(exact);
  await button.click(); await page.getByTestId('schedule-confirm').click();
  await expect.poll(() => server.mutations).toEqual([{ id: 'zone', action: 'PATCH',
    body: { revision: 1, scheduledAt: exact, timeZone: 'Europe/Warsaw' } }]);
  expect(server.rows[0].scheduledAt).toBe(exact);
});

test('older unseen sent results remain reachable past two pages and list errors can be retried', async ({ page }) => {
  const server = queueServer(Array.from({ length: 425 }, (_, index) => queueRow(`history-${index}`, {
    subject: `Unseen result ${index + 1}`, scheduledAt: new Date(Date.UTC(2020, 0, 15) - index * 60_000).toISOString(),
  })));
  server.failList = true;
  await bootQueue(page, server); await enterQueue(page);
  await expect(page.getByRole('alert')).toContainText('Could not load');
  server.failList = false; await page.getByTestId('scheduled-refresh').click();
  await expect(page.getByTestId('scheduled-item-history-0')).toBeVisible();
  await queueVisibility(page, 'hidden');
  for (let pageNumber = 0; pageNumber < 2; pageNumber++) {
    await page.getByTestId('scheduled-load-more').scrollIntoViewIfNeeded();
    await page.getByTestId('scheduled-load-more').click();
    await expect(page.getByTestId('scheduled-view')).toHaveAttribute('aria-busy', 'false');
  }
  await expect(page.getByTestId('scheduled-item-history-424')).toBeAttached();
  expect(server.seen.has('queue-owner:history-424')).toBe(false);
  await page.getByTestId('scheduled-item-history-424').scrollIntoViewIfNeeded();
  await queueVisibility(page, 'visible');
  await expect.poll(() => server.seen.has('queue-owner:history-424')).toBe(true);
});


test('reschedule errors stay inside the dialog, busy controls cannot close it, and reopening clears old errors', async ({ page }) => {
  const exact = '2030-01-15T12:45:00.000Z';
  const server = queueServer([queueRow('errors', { state: 'pending', scheduledAt: exact })]);
  await bootQueue(page, server); await enterQueue(page);
  await page.getByTestId('scheduled-item-errors').getByRole('button').click();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  await page.route('**/api/mail/scheduled/errors', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    requests++; await gate;
    return route.fulfill({ status: 503, json: { error: 'Temporary scheduling failure' } });
  });
  try {
    const trigger = page.getByTestId('scheduled-reschedule-errors');
    await trigger.click(); await page.getByTestId('schedule-confirm').click();
    await expect.poll(() => requests).toBe(1);
    const dialog = page.getByTestId('schedule-dialog');
    await expect(page.getByTestId('schedule-date')).toBeDisabled();
    await expect(page.getByTestId('schedule-confirm')).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
    release();
    await expect(dialog.getByRole('alert')).toContainText('The action could not be confirmed');
    await expect(page.getByTestId('schedule-confirm')).toBeEnabled();
    expect(server.rows[0].scheduledAt).toBe(exact); expect(server.rows[0].state).toBe('pending');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(trigger).toBeFocused();
    await trigger.click(); await expect(dialog.getByRole('alert')).toHaveCount(0);
    expect(server.sendCalls).toBe(0); expect(server.seenCalls).toEqual([]);
  } finally { release(); }
});


test('Refresh retries a failed preview and discovers a Sent copy imported after the first read without editing delivery', async ({ page }) => {
  const server = queueServer([queueRow()]);
  await bootQueue(page, server); await enterQueue(page);
  let failPreview = true;
  await page.route('**/api/mail/scheduled/overnight', async route => {
    if (failPreview && route.request().method() === 'GET') return route.fulfill({ status: 503, json: { error: 'Temporary preview failure' } });
    return route.fallback();
  });
  const row = page.getByTestId('scheduled-item-overnight');
  await row.getByRole('button').click();
  const preview = page.getByTestId('scheduled-preview');
  await expect(preview).toContainText('Could not load this preview');
  failPreview = false; await page.getByTestId('scheduled-refresh').click();
  await expect(preview).toContainText('The message copy is unavailable');
  expect(server.previews).toEqual(['overnight']);
  const sentId = 'd1000000-0000-4000-8000-000000000004';
  server.previewOverrides.set('overnight', { sentCopy: { id: sentId, accountId: QUEUE_ACCOUNT,
    subject: 'Imported Sent copy', fromEmail: 'alias@example.test', fromName: 'Work', date: '2020-01-15T12:00:00Z', snippet: 'Imported after sync' } });
  await page.getByTestId('scheduled-refresh').click();
  await expect(page.frameLocator('[data-message-detail-body] iframe').getByText('The real earlier message in the Atlas conversation.')).toBeVisible();
  expect(server.previews).toEqual(['overnight', 'overnight']); expect(server.bodyReads).toEqual([sentId]);
  expect(server.rows[0].state).toBe('sent'); expect(server.rows[0].revision).toBe(1);
  expect(server.mutations).toEqual([]); expect(server.sendCalls).toBe(0);
  await expect.poll(() => server.seenCalls).toEqual(['queue-owner:overnight']);
  await expect(page.getByTestId('scheduled-status-overnight').last()).toHaveText('Sent');
});
