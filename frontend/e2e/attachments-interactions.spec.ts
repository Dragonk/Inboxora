import { test, expect } from './fixtures.ts';
import { attachmentMessage, fileBytes, preview } from './attachment-fixtures.ts';
import { BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js/index-native.js';

for (const theme of ['light', 'dark']) test(`PDF typed zoom and readable precise highlights (${theme})`, async ({ page, fixtureApi }) => {
  await fixtureApi; await attachmentMessage(page, ['hundred-pages.pdf'], { theme });
  const dialog = await preview(page, 'hundred-pages.pdf');
  const zoom = dialog.getByRole('spinbutton', { name: 'Zoom', exact: true });
  await expect(zoom).toHaveValue('100');
  await zoom.fill('133'); await zoom.press('Enter'); await expect(zoom).toHaveValue('133');
  await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click(); await expect(zoom).toHaveValue('158');
  await zoom.press('ArrowDown'); await expect(zoom).toHaveValue('133');
  await zoom.fill('999'); await zoom.press('Enter'); await expect(zoom).toHaveValue('400');
  await zoom.fill('0'); await zoom.press('Enter'); await expect(zoom).toHaveValue('50');
  await zoom.fill(''); await zoom.press('Enter'); await expect(zoom).toHaveValue('50');
  await zoom.fill('100'); await zoom.press('Enter');
  const find = dialog.getByRole('button', { name: 'Find in document', exact: true });
  if (await find.isVisible()) await find.click();
  await dialog.getByRole('searchbox').fill('invoice-042');
  const hit = dialog.locator('[data-pdf-page="42"] .attachment-pdf-hit[data-current-match=true]');
  await expect(hit.first()).toBeVisible();
  const geometry = await hit.first().evaluate(element => {
    const rect = element.getBoundingClientRect(); const page = element.closest('[data-pdf-page]')!;
    const bounds = page.getBoundingClientRect();
    const span = [...page.querySelectorAll('.textLayer span')].find(item => item.textContent?.includes('invoice-042'))!;
    return { background: getComputedStyle(element).backgroundColor, pointer: getComputedStyle(element).pointerEvents,
      x: rect.x - bounds.x, y: rect.y - bounds.y, width: rect.width, height: rect.height, spanWidth: span.getBoundingClientRect().width };
  });
  expect(geometry.background).toMatch(/0\.(25|3)\)/); expect(geometry.pointer).toBe('none');
  expect(geometry.width).toBeGreaterThan(20); expect(geometry.width).toBeLessThan(geometry.spanWidth);
  expect(geometry.height).toBeGreaterThan(4); expect(geometry.x).toBeGreaterThan(0); expect(geometry.y).toBeGreaterThan(0);
  await page.screenshot({ path: `artifacts/pdf-readable-search-${theme}-${page.viewportSize()?.width}.png` });
});

test('signature metadata preserves real newlines and stays inert', async ({ page, fixtureApi }) => {
  await fixtureApi; await attachmentMessage(page, ['signature-sample.pdf']);
  const reason = 'Signed by: Fixture\nSMS signature\n<script>document.body.remove()</script>';
  await page.route('**/attachments/process/signatures', route => {
    const report = JSON.parse(fileBytes('signature-sample.pdf.json').toString());
    report.signatures[0].reason = reason; return route.fulfill({ json: report });
  });
  const dialog = await preview(page, 'signature-sample.pdf');
  await dialog.getByRole('button', { name: 'Signatures', exact: true }).click();
  const details = page.getByTestId('attachment-signature-dialog');
  const value = details.locator('dd').filter({ hasText: 'SMS signature' });
  await expect(value).toHaveText(reason); await expect(value).toHaveCSS('white-space', 'pre-wrap');
  await expect(value.locator('script')).toHaveCount(0);
});

test('window controls follow the requested order', async ({ page, fixtureApi, isMobile }) => {
  await fixtureApi; await attachmentMessage(page, ['image.png']);
  const dialog = await preview(page, 'image.png');
  await expect(dialog.getByRole('button', { name: 'Open in new browser window', exact: true })).toBeVisible();
  const labels = () => page.locator('.attachment-main-toolbar button').evaluateAll(items => items.map(item => item.getAttribute('aria-label')));
  expect((await labels()).slice(isMobile ? -2 : -3)).toEqual(isMobile ? ['Open in new browser window', 'Close'] : ['Open in new browser window', 'Open in window', 'Close']);
  if (isMobile) return;
  await dialog.getByRole('button', { name: 'Open in window', exact: true }).click();
  await expect(page.locator('.mailflow-window .attachment-main-toolbar')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open in new browser window', exact: true })).toBeVisible();
  expect((await labels()).slice(-4)).toEqual(['Open in new browser window', 'Minimize', 'Return to full screen', 'Close']);
  await page.getByRole('button', { name: 'Return to full screen', exact: true }).click();
  await expect(dialog).toBeVisible();
});

test('archive grid, folders and list share safe file previews', async ({ page, fixtureApi }) => {
  await fixtureApi; await attachmentMessage(page, ['archive.zip']);
  const zip = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  await zip.add('photos/image.png', new Uint8ArrayReader(new Uint8Array(fileBytes('image.png'))));
  await zip.add('notes.txt', new Uint8ArrayReader(new TextEncoder().encode('Explorer text fixture')));
  const bytes = Buffer.from(await (await zip.close()).arrayBuffer());
  await page.route('**/api/mail/messages/*/attachments/archive.zip*', route => route.fulfill({ body: bytes, headers: { 'X-Attachment-Scan': 'disabled' } }));
  const dialog = await preview(page, 'archive.zip');
  const archive = dialog.locator('.attachment-archive');
  await expect(archive).toHaveAttribute('data-view', 'grid');
  await archive.getByRole('button', { name: 'photos/', exact: true }).click();
  await expect(archive.locator('.attachment-archive-thumbnail img')).toBeVisible();
  await archive.getByRole('button', { name: 'List', exact: true }).click();
  await expect(archive).toHaveAttribute('data-view', 'list');
  await archive.getByRole('button', { name: 'photos/image.png', exact: true }).click();
  await expect(dialog.locator('.attachment-image img')).toBeVisible();
  await dialog.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(archive).toHaveAttribute('data-view', 'list');
  await archive.getByRole('button', { name: 'notes.txt', exact: true }).click();
  await expect(dialog.locator('pre')).toContainText('Explorer text fixture');
});

test('composer attachments preview without sending, and the menu arrow matches its position', async ({ page, fixtureApi, isMobile }) => {
  await fixtureApi; await attachmentMessage(page, ['text.txt']);
  await page.getByRole('button', { name: 'Compose', exact: true }).first().click();
  await expect(page.getByTestId('compose-from')).toBeVisible();
  await expect(page.getByTestId('compose-send-menu').locator('path')).toHaveAttribute('d', isMobile && (page.viewportSize()?.width || 0) < 768 ? 'm3 6 5 5 5-5' : 'm3 10 5-5 5 5');
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'local.pdf', mimeType: 'application/pdf', buffer: fileBytes('hundred-pages.pdf') });
  const sends: string[] = []; const sourceReads: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/mail\/(send|scheduled)(\?|$)/.test(request.url())) sends.push(request.url());
    if (request.method() === 'GET' && /\/attachments\//.test(request.url())) sourceReads.push(request.url());
  });
  await page.getByRole('button', { name: 'Preview local.pdf', exact: true }).click();
  const dialog = page.getByTestId('attachment-preview-dialog');
  await expect(dialog.locator('[data-pdf-page="1"] canvas')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Preview local.pdf', exact: true })).toBeVisible();
  expect(sends).toEqual([]); expect(sourceReads).toEqual([]);
  await page.getByRole('button', { name: 'Remove local.pdf', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Preview local.pdf', exact: true })).toHaveCount(0);
});

test('local composer previews respect scan refusal and keep the original attachment', async ({ page, fixtureApi }) => {
  await fixtureApi; await attachmentMessage(page, ['text.txt']);
  await page.getByRole('button', { name: 'Compose', exact: true }).first().click();
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'local.txt', mimeType: 'text/plain', buffer: fileBytes('text.txt') });
  await page.route('**/api/mail/attachments/process/scan', route => {
    expect(route.request().headers()['x-requested-with']).toBe('MailFlow');
    return route.fulfill({ status: 422, json: { code: 'INFECTED' } });
  });
  await page.getByRole('button', { name: 'Preview local.txt', exact: true }).click();
  const dialog = page.getByTestId('attachment-preview-dialog');
  await expect(dialog.getByRole('alert')).toContainText('blocked');
  await expect(dialog.locator('pre,iframe,canvas,img')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  const warning = page.getByTestId('attachment-dangerous-dialog');
  await expect(warning).toContainText('scanner has not confirmed');
  await warning.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Preview local.txt', exact: true })).toBeVisible();
});
