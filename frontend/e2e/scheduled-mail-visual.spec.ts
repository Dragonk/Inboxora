import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { bootQueue, enterQueue, leaveQueue, queueMessage, queueRow, queueServer, QUEUE_ACCOUNT } from './scheduled-view-fixtures.ts';

test.use({ serviceWorkers: 'block', timezoneId: 'Europe/Warsaw' });

async function capture(page: Page, info: TestInfo, name: string) {
  await expect(page.getByTestId('scheduled-view').or(page.getByTestId('compose-from')).first()).toBeVisible();
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}
async function dialogFits(page: Page, name: string) {
  const dialog = page.getByTestId(name);
  await expect(dialog).toBeVisible();
  const rect = await dialog.boundingBox(); const viewport = page.viewportSize();
  expect(rect).not.toBeNull(); expect(viewport).not.toBeNull();
  if (!rect || !viewport) throw new Error('Expected a visible dialog and viewport');
  expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height + 1);
  return dialog;
}
for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: queue, reply preview, schedule and merge dialogs fit desktop, portrait and landscape`, async ({ page }, info) => {
    const server = queueServer([
      queueRow('atlas', { state: 'pending', scheduledAt: '2030-01-15T12:45:00Z' }),
      queueRow('long', { state: 'editing', subject: 'Quarterly planning — a deliberately long subject that must not push the queue outside its column', scheduledAt: '2030-01-16T09:00:00Z' }),
      queueRow('partial', { state: 'partial', subject: 'Design review — one recipient needs attention', scheduledAt: '2030-01-14T08:00:00Z' }),
      queueRow('sent', { subject: 'Weekly product update', scheduledAt: '2030-01-13T22:00:00Z' }),
    ]);
    server.previewOverrides.set('atlas', { context: [{ id: queueMessage.replyToMessageId!, accountId: QUEUE_ACCOUNT,
      subject: 'Project Atlas — planning', fromName: 'Taylor Reed', fromEmail: 'taylor@example.test',
      date: '2026-09-27T12:00:00Z', snippet: 'Could you share the revised milestones?' }] });
    await bootQueue(page, server, { theme }); await enterQueue(page);
    await expect(page.locator('html')).toHaveAttribute('data-inboxora-surface', theme);
    await capture(page, info, `${theme}-queue-list`);
    await page.getByTestId('scheduled-item-atlas').getByRole('button').click();
    await expect(page.frameLocator('iframe[title="Message preview"]').getByText('Hi Taylor,')).toBeVisible();
    await expect(page.getByTestId('scheduled-preview')).toContainText('milestones.txt');
    expect(server.mutations).toEqual([]);
    await capture(page, info, `${theme}-queue-preview`);
    const reschedule = page.getByTestId('scheduled-reschedule-atlas'); await reschedule.click();
    const schedule = await dialogFits(page, 'schedule-dialog');
    await expect(schedule.getByRole('heading', { name: 'Reschedule', exact: true })).toBeVisible();
    const dateInput = page.getByTestId('schedule-date');
    await expect(dateInput).toHaveCSS('color-scheme', theme);
    await expect(page.getByTestId('schedule-zone')).toHaveCount(0);
    await capture(page, info, `${theme}-schedule-dialog`);
    await schedule.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(reschedule).toBeFocused();
    await leaveQueue(page);
    await page.getByRole('button', { name: 'Compose', exact: true }).first().click();
    const to = page.getByTestId('compose-to');
    for (const address of ['taylor@example.test', 'jordan@example.test', 'sam@example.test']) {
      await to.fill(address); await to.press('Enter');
    }
    await page.getByPlaceholder(/^(Add a subject|Subject)$/).fill('Project Atlas — progress update');
    await page.locator('.tiptap-compose [contenteditable="true"]').fill('The updated project plan is ready. Thank you for your feedback.');
    if ((page.viewportSize()?.width ?? 0) >= 768) {
      const body = page.getByTestId('compose-body-scroll');
      const box = await body.boundingBox();
      expect(box).not.toBeNull(); expect(box!.height).toBeGreaterThanOrEqual(80);
      await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await expect(page.getByTestId('compose-send')).toBeVisible();
      await body.evaluate(element => { element.scrollTop = 0; });
    }
    const trigger = page.getByTestId('compose-send-menu');
    await trigger.click(); await capture(page, info, `${theme}-split-send-menu`);
    await page.getByTestId('compose-mail-merge').click();
    const merge = await dialogFits(page, 'mail-merge-dialog');
    await expect(merge).toContainText('3 unique recipients');
    await expect(merge.getByRole('button', { name: 'Send mail merge', exact: true })).toBeEnabled();
    await capture(page, info, `${theme}-merge-dialog`);
    await page.keyboard.press('Escape'); await expect(merge).toHaveCount(0); await expect(trigger).toBeFocused();
    expect(server.sendCalls).toBe(0); expect(server.mutations).toEqual([]);
  });
}
