import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';
import { attachmentMessage, fileBytes, preview } from './attachment-fixtures.ts';

for (const theme of ['light', 'dark']) {
  test(`compact preview controls, default PDF zoom and document fidelity (${theme})`, async ({ page, fixtureApi, isMobile }) => {
    await fixtureApi;
    await attachmentMessage(page, ['hundred-pages.pdf', 'notes.md', 'paged-background.docx', 'image.png'], { theme });
    let dialog = await preview(page, 'hundred-pages.pdf');
    await expect(dialog.getByRole('combobox', { name: 'Zoom', exact: true })).toHaveValue('1');
    const geometry = await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect(); const header = element.querySelector('.attachment-main-toolbar')!;
      const filename = header.querySelector('.attachment-filename')!.getBoundingClientRect();
      const download = header.querySelector('button[aria-label="Download"]')!.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, vw: innerWidth, vh: innerHeight,
        row: Math.abs((filename.top+filename.bottom)/2-(download.top+download.bottom)/2),
        headerOverflow: header.scrollWidth > header.clientWidth+1 };
    });
    expect(geometry.x).toBe(0); expect(geometry.y).toBe(0);
    expect(geometry.width).toBeCloseTo(geometry.vw, 0); expect(geometry.height).toBeCloseTo(geometry.vh, 0);
    expect(geometry.row).toBeLessThan(2); expect(geometry.headerOverflow).toBe(false);
    const fit = dialog.getByRole('button', { name: 'Fit width', exact: true });
    await expect(fit).toHaveAttribute('title', /Fit the page/); await expect(fit.locator('svg')).toHaveCount(1); await expect(fit).toHaveText('');
    const toggle = dialog.getByRole('button', { name: 'Find in document', exact: true });
    if (isMobile || (page.viewportSize()?.width || 0) < 920) {
      await expect(dialog.getByRole('searchbox')).toBeHidden(); await toggle.click(); await expect(dialog.getByRole('searchbox')).toBeFocused();
    } else {
      await expect(toggle).toBeHidden();
      const sameRow = await dialog.evaluate(root => {
        const search = root.querySelector('input[type=search]')!.getBoundingClientRect();
        const print = root.querySelector('button[aria-label=Print]')!.getBoundingClientRect();
        return Math.abs(search.top-print.top) < 10 && search.left > print.right;
      });
      expect(sameRow).toBe(true);
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    dialog = await preview(page, 'notes.md');
    const diagram = dialog.locator('.ai-mermaid svg'); await expect(diagram).toBeVisible();
    await expect(diagram.locator('text')).not.toHaveCount(0);
    await expect(diagram.locator('foreignObject')).toHaveCount(0);
    expect((await diagram.locator('text').allTextContents()).join(' ').trim().length).toBeGreaterThan(3);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    dialog = await preview(page, 'paged-background.docx');
    const document = dialog.locator('iframe').contentFrame();
    await expect(document.locator('section.docx')).toHaveCount(2);
    await expect(document.locator('body')).toContainText('Second page preserved');
    const pageStyle = await document.locator('section.docx').first().evaluate(element => {
      const style = getComputedStyle(element); return { background: style.backgroundColor, height: parseFloat(style.minHeight), width: parseFloat(style.width) };
    });
    expect(pageStyle.background).toBe('rgb(220, 235, 250)'); expect(pageStyle.height).toBeGreaterThan(900); expect(pageStyle.width).toBeGreaterThan(700);
    await page.screenshot({ path: `artifacts/attachment-document-${theme}-${page.viewportSize()?.width}.png` });
  });
}

test('floating previews return to fullscreen and native browser windows use private blobs', async ({ page, fixtureApi, isMobile }) => {
  await fixtureApi; await attachmentMessage(page, ['image.png', 'hundred-pages.pdf', 'document.html']);
  let dialog = await preview(page, 'image.png');
  await expect(dialog.locator('.attachment-image img')).toBeVisible();
  await dialog.getByRole('button', { name: 'Rotate left', exact: true }).click();
  await expect(dialog.locator('.attachment-image img')).toHaveAttribute('style', /270deg/);
  await dialog.getByRole('button', { name: 'Rotate right', exact: true }).click();
  await expect(dialog.locator('.attachment-image img')).toHaveAttribute('style', /0deg/);
  if (!isMobile) {
    await dialog.getByRole('button', { name: 'Open in window', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const floating = page.locator('.mailflow-window').filter({ has: page.getByTestId('attachment-preview-surface') });
    await expect(floating.locator('.mailflow-window-titlebar')).toHaveCount(0);
    await floating.getByRole('button', { name: 'Return to full screen', exact: true }).click();
    await expect(floating).toHaveCount(0); dialog = page.getByTestId('attachment-preview-dialog'); await expect(dialog).toBeVisible();
  }
  for (const name of ['image.png', 'hundred-pages.pdf']) {
    if (name !== 'image.png') dialog = await preview(page, name);
    const popupPromise = page.waitForEvent('popup');
    await dialog.getByRole('button', { name: 'Open in new browser window', exact: true }).click();
    const popup = await popupPromise; await popup.waitForURL(/^blob:/);
    expect(popup.url()).not.toContain('/api/mail/'); expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    await popup.close(); await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  }
  dialog = await preview(page, 'document.html');
  await expect(dialog.locator('iframe')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Open in new browser window', exact: true })).toHaveCount(0);
});

test('all native archive formats reuse the preview without filesystem extraction', async ({ page, fixtureApi }) => {
  await fixtureApi;
  const names = ['archive.7z','archive.rar','archive.tar','archive.tar.gz','single.txt.gz','sample-rar5.rar'];
  await attachmentMessage(page, names);
  for (const name of names) {
    const dialog = await preview(page, name);
    await expect(dialog.locator('.attachment-archive li')).not.toHaveCount(0);
    await dialog.locator('.attachment-archive li button:enabled').first().click();
    await expect(dialog.locator('.attachment-markdown,.attachment-code')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(dialog.locator('.attachment-archive')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  }
});

test('signature dialog exposes certificate details and never paints an uncertain result green', async ({ page, fixtureApi }) => {
  await fixtureApi; await attachmentMessage(page, ['signature-sample.pdf']);
  let status: 'valid'|'invalid'|'unknown' = 'valid'; let incomplete = false;
  await page.route('**/api/mail/attachments/process/signatures', route => {
    const report = JSON.parse(fileBytes('signature-sample.pdf.json').toString());
    report.status = status; report.signatures[0].status = status;
    report.signatures[0].integrity = status === 'invalid' ? 'invalid' : 'valid';
    if (incomplete) report.signatures[0].revocation = 'unknown';
    return route.fulfill({ json: report });
  });
  const dialog = await preview(page, 'signature-sample.pdf');
  const badge = dialog.getByRole('button', { name: 'Signatures', exact: true }).locator('.attachment-status-dot');
  await expect(badge).toHaveAttribute('data-status', 'valid');
  await dialog.getByRole('button', { name: 'Signatures', exact: true }).click();
  const details = page.getByTestId('attachment-signature-dialog');
  await expect(details).toContainText('Inboxora synthetic signer'); await expect(details).toContainText('fixture@example.test');
  await expect(details).toContainText('Signing certificate'); await expect(details).toContainText('at the current time');
  for (const next of ['invalid','unknown'] as const) {
    status = next; await details.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(badge).toHaveAttribute('data-status', next);
    await expect(details.getByRole('navigation').locator('.attachment-status-dot')).toHaveAttribute('data-status', next);
  }
  incomplete = true; status = 'valid';
  await details.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(badge).toHaveAttribute('data-status', 'unknown');
  await page.screenshot({ path: `artifacts/attachment-signatures-${page.viewportSize()?.width}.png` });
});

for (const code of ['INFECTED','SCAN_UNAVAILABLE','SCAN_LIMIT']) {
  test(`${code}: blocked previews require an explicit warning before download`, async ({ page, fixtureApi }) => {
    await fixtureApi; await attachmentMessage(page, ['text.txt']);
    let downloads = 0;
    await page.route('**/api/mail/messages/*/attachments/text.txt*', route => {
      if (new URL(route.request().url()).searchParams.get('preview') === '1') return route.fulfill({ status: 422, json: { code } });
      downloads++; return route.fulfill({ contentType: 'application/octet-stream', body: fileBytes('text.txt') });
    });
    const dialog = await preview(page, 'text.txt');
    await expect(dialog.getByRole('alert')).toContainText('blocked');
    await expect(dialog.locator('iframe,canvas,.attachment-code,img')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Open in new browser window', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Download', exact: true }).click();
    const warning = page.getByTestId('attachment-dangerous-dialog');
    await expect(warning).toContainText('scanner has not confirmed'); expect(downloads).toBe(0);
    await warning.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(downloads).toBe(0);
    await dialog.getByRole('button', { name: 'Download', exact: true }).click();
    const download = page.waitForEvent('download');
    await warning.getByRole('button', { name: /Download/ }).click(); const saved = await download;
    expect(saved.url()).not.toContain('preview=1');
    const path = await saved.path(); expect(path).not.toBeNull();
    expect(await readFile(path!)).toEqual(fileBytes('text.txt'));
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Download text.txt', exact: true }).first().click();
    await expect(page.getByRole('dialog').last()).toContainText('scanner has not confirmed');
  });
}

async function drop(page: Page, files: Array<{ name: string; size: number }>) {
  const transfer = await page.evaluateHandle(entries => {
    const data = new DataTransfer();
    for (const entry of entries) data.items.add(new File([new Uint8Array(entry.size)], entry.name, { type: 'text/plain' }));
    return data;
  }, files);
  const body = page.getByTestId('compose-body-scroll');
  await body.dispatchEvent('dragenter', { dataTransfer: transfer });
  await expect(body).toHaveAttribute('data-file-drag', 'true');
  await body.dispatchEvent('drop', { dataTransfer: transfer }); await transfer.dispose();
}

test('file drop attaches bytes, checks the aggregate limit and shows the configured warning', async ({ page, fixtureApi }) => {
  await fixtureApi;
  await page.route('**/api/auth/preferences**', route => route.fulfill({ json: { language: 'en', attachmentWarningMiB: 1, undoSendSeconds: 0 } }));
  await page.route('**/api/mail/send-limits**', route => route.fulfill({ json: { transport: 'smtp', limits: { singleAttachmentBytes: 4*1024*1024, totalAttachmentBytes: 5*1024*1024 } } }));
  await page.route('**/api/mail/send', route => route.fulfill({ status: 503, json: { error: 'Fixture cannot send actual mail' } }));
  Object.assign(page, { __languageOverride: 'en' }); await page.goto('/');
  await page.getByRole('button', { name: 'Compose', exact: true }).first().click();
  await expect(page.getByTestId('compose-from')).toBeVisible();
  await drop(page, [{ name: 'dropped.txt', size: 2*1024*1024 }]);
  await expect(page.getByText('dropped.txt', { exact: true })).toBeVisible();
  await expect(page.getByText(/Attachments exceed 1 MiB/)).toBeVisible();
  await expect(page.locator('.tiptap-compose img')).toHaveCount(0);
  await drop(page, [{ name: 'batch-one.txt', size: 2*1024*1024 }, { name: 'batch-two.txt', size: 2*1024*1024 }]);
  await expect(page.getByText('batch-one.txt', { exact: true })).toHaveCount(0);
  await expect(page.getByText('batch-two.txt', { exact: true })).toHaveCount(0);
  await expect(page.getByText('dropped.txt', { exact: true })).toBeVisible();
  await expect(page.getByTestId('compose-body-scroll')).toHaveAttribute('data-file-drag', 'false');
});

test('PDF rotation controls respect the original page orientation', async ({ page, fixtureApi }) => {
  await fixtureApi; await attachmentMessage(page, ['rotated-page.pdf']);
  const dialog = await preview(page, 'rotated-page.pdf'); const first = dialog.locator('[data-pdf-page="1"]');
  await expect(first.locator('canvas')).toBeVisible();
  await expect.poll(() => first.evaluate(node => node.getBoundingClientRect().width > node.getBoundingClientRect().height)).toBe(true);
  await dialog.getByRole('button', { name: 'Rotate left', exact: true }).click();
  await expect.poll(() => first.evaluate(node => node.getBoundingClientRect().height > node.getBoundingClientRect().width)).toBe(true);
  await dialog.getByRole('button', { name: 'Rotate right', exact: true }).click();
  await expect.poll(() => first.evaluate(node => node.getBoundingClientRect().width > node.getBoundingClientRect().height)).toBe(true);
});
