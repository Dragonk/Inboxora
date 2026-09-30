import { test, expect } from './fixtures.ts';
import { attachmentMessage, preview } from './attachment-fixtures.ts';

test.describe('complete attachment preview', () => {
  test.setTimeout(120000);

  test('all raster, SVG and TIFF images render with gallery, zoom and rotation', async ({ page, fixtureApi }) => {
    await fixtureApi;
    const names = ['png', 'jpg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'tiff'].map(ext => `image.${ext}`);
    await attachmentMessage(page, [...names, 'second.png', 'text.txt']);
    for (const name of names) {
      const dialog = await preview(page, name);
      const image = dialog.locator('.attachment-image img');
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await expect(image).toHaveAttribute('style', /1.25/);
      await dialog.getByRole('button', { name: 'Rotate', exact: true }).click();
      await expect(image).toHaveAttribute('style', /90deg/);
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    }
    const dialog = await preview(page, 'second.png');
    await dialog.getByRole('button', { name: 'Next image', exact: true }).click();
    await expect(dialog.locator('.attachment-image img')).toHaveAttribute('alt', 'image.png');
    await expect(dialog.locator('.attachment-gallery button[aria-current="true"]')).toHaveAccessibleName('image.png');
  });

  test('text, JSONC, XML and CSV preserve source, find matches and readable fallbacks', async ({ page, fixtureApi }) => {
    await fixtureApi;
    await attachmentMessage(page, ['text.txt', 'polish.txt', 'data.jsonc', 'data.xml', 'data.csv', 'data.tsv', 'invalid.json', 'invalid.xml']);
    let dialog = await preview(page, 'text.txt');
    await expect(dialog.locator('pre')).toContainText('Zażółć gęślą jaźń');
    await page.keyboard.press('Control+f');
    await expect(dialog.getByRole('searchbox')).toBeFocused();
    await dialog.getByRole('searchbox').fill('needle');
    await expect(dialog.locator('mark')).toHaveCount(2);
    await dialog.getByRole('button', { name: 'Next match', exact: true }).click();
    await expect(dialog.locator('mark[data-current-match="true"]')).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    for (const [name, text] of [['polish.txt', 'Zażółć gęślą jaźń'], ['data.jsonc', '9007199254740993'], ['data.xml', 'Inboxora XML'], ['data.csv', 'Fixture, One'], ['data.tsv', 'Fixture'], ['invalid.json', '{"broken": [1,2,}'], ['invalid.xml', '<root><broken></root>']]) {
      dialog = await preview(page, name);
      await expect(dialog.locator('.attachment-content')).toContainText(text);
      if (name.startsWith('invalid')) await expect(dialog).toContainText('Formatting failed');
      if (name === 'data.jsonc') await expect(dialog).toContainText('Preserve this comment');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    }
  });

  test('Markdown renders Mermaid and retains rejected diagram source', async ({ page, fixtureApi }) => {
    await fixtureApi;
    await attachmentMessage(page, ['notes.md', 'invalid-mermaid.md']);
    let dialog = await preview(page, 'notes.md');
    await expect(dialog.locator('.ai-mermaid svg')).toBeVisible();
    await expect(dialog.locator('.attachment-markdown')).toContainText('Inboxora Markdown');
    await dialog.getByRole('button', { name: 'Source', exact: true }).click();
    await expect(dialog.locator('pre')).toContainText('flowchart LR');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    dialog = await preview(page, 'invalid-mermaid.md');
    await expect(dialog.locator('code.language-mermaid')).toContainText('securityLevel');
    await expect(dialog.locator('.ai-mermaid svg')).toHaveCount(0);
  });

  test('100-page PDF uses lazy canvases, page 87, outline, search, thumbnails and shortcuts', async ({ page, fixtureApi }) => {
    await fixtureApi;
    await attachmentMessage(page, ['hundred-pages.pdf']);
    const dialog = await preview(page, 'hundred-pages.pdf');
    await expect(dialog.locator('[data-pdf-page]')).toHaveCount(100);
    await expect(dialog.locator('[data-pdf-page="1"] canvas')).toBeVisible();
    expect(await dialog.locator('.attachment-pdf-scroll canvas').count()).toBeLessThan(12);
    const pageNumber = dialog.locator('[data-pdf-page-input]');
    await pageNumber.fill('87'); await pageNumber.press('Enter');
    await expect(dialog.locator('[data-pdf-page="87"] canvas')).toBeVisible();
    await expect(pageNumber).toHaveValue('87');
    await dialog.getByRole('searchbox').fill('invoice-042');
    await expect(pageNumber).toHaveValue('42');
    await expect(dialog.locator('.attachment-pdf-snippet')).toContainText('invoice-042');
    await dialog.getByRole('searchbox').fill('');
    await dialog.getByRole('button', { name: 'Table of contents', exact: true }).click();
    await dialog.locator('.attachment-outline summary').first().click();
    await dialog.getByRole('button', { name: 'Jump to page 87', exact: true }).click();
    await expect(pageNumber).toHaveValue('87');
    await dialog.getByRole('button', { name: 'Page thumbnails', exact: true }).click();
    await expect(dialog.locator('.attachment-pdf-thumb').first()).toBeVisible();
    await dialog.locator('.attachment-pdf-thumb').first().click();
    await expect(pageNumber).toHaveValue('1');
    await dialog.getByRole('button', { name: 'Page thumbnails', exact: true }).click();
    await dialog.locator('.attachment-pdf-scroll').focus();
    await page.keyboard.press('End'); await expect(pageNumber).toHaveValue('100');
    await page.keyboard.press('Home'); await expect(pageNumber).toHaveValue('1');
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    await expect(page.locator('[data-message-detail-attachment]')).toBeFocused();
  });

  test('PDF password stays local, accepts correction and reports unsigned signature fields honestly', async ({ page, fixtureApi }) => {
    await fixtureApi;
    const serverCalls: string[] = [];
    page.on('request', request => { if (request.url().includes('/attachments/process/')) serverCalls.push(request.url()); });
    await attachmentMessage(page, ['password.pdf', 'empty-signature.pdf']);
    let dialog = await preview(page, 'password.pdf');
    let prompt = page.getByTestId('attachment-password-dialog');
    await expect(prompt).toBeVisible();
    await prompt.getByLabel('Password', { exact: true }).fill('wrong');
    await prompt.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(prompt).toContainText('Incorrect password');
    await prompt.getByLabel('Password', { exact: true }).fill('preview-password');
    await prompt.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(dialog.locator('.textLayer')).toContainText('Unlocked PDF fixture');
    expect(serverCalls).toEqual([]);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    dialog = await preview(page, 'empty-signature.pdf');
    await expect(dialog.locator('.attachment-signatures')).toContainText('Signature fields: 1');
    await dialog.locator('.attachment-signatures summary').click();
    await expect(dialog.locator('.attachment-signatures')).toContainText('have not been cryptographically verified');
  });

  test('DOCX, XLSX, XLS and ODS show content, tabs and corrected Office passwords', async ({ page, fixtureApi }) => {
    await fixtureApi;
    await attachmentMessage(page, ['document.docx', 'workbook.xlsx', 'workbook.xls', 'workbook.ods', 'example_password.docx', 'example_password.xlsx']);
    let dialog = await preview(page, 'document.docx');
    await expect(dialog.locator('iframe').contentFrame().locator('body')).toContainText('Inboxora DOCX preview');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    for (const ext of ['xlsx', 'xls', 'ods']) {
      dialog = await preview(page, `workbook.${ext}`);
      await expect(dialog.locator('table')).toContainText('Preview widget');
      await dialog.getByRole('tab', { name: 'Notes', exact: true }).click();
      await expect(dialog.locator('table')).toContainText('Second worksheet text');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    }
    for (const ext of ['docx', 'xlsx']) {
      dialog = await preview(page, `example_password.${ext}`);
      await dialog.getByRole('button', { name: 'Unlock', exact: true }).click();
      const prompt = page.getByTestId('attachment-password-dialog');
      await prompt.getByLabel('Password', { exact: true }).fill('wrong');
      await prompt.getByRole('button', { name: 'Unlock', exact: true }).click();
      await expect(prompt).toContainText('Incorrect password');
      await prompt.getByLabel('Password', { exact: true }).fill('Password1234_');
      await prompt.getByRole('button', { name: 'Unlock', exact: true }).click();
      if (ext === 'docx') await expect(dialog.locator('iframe').contentFrame().locator('body')).toContainText('Lorem ipsum');
      else await expect(dialog.locator('table')).toContainText('lorem');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    }
  });

  test('ZIP entries use the same viewers, nested Back and resource limits', async ({ page, fixtureApi }) => {
    await fixtureApi;
    await attachmentMessage(page, ['archive.zip', 'nested.zip', 'encrypted.zip', 'unsafe-path.zip', 'large-entry.zip', 'too-many.zip']);
    let dialog = await preview(page, 'archive.zip');
    await dialog.getByRole('button', { name: 'hundred-pages.pdf', exact: true }).click();
    await expect(dialog.locator('[data-pdf-page]')).toHaveCount(100);
    await page.keyboard.press('Escape');
    await expect(dialog.locator('.attachment-archive')).toBeVisible();
    await dialog.getByRole('button', { name: 'notes.md', exact: true }).click();
    await expect(dialog.locator('.ai-mermaid svg')).toBeVisible();
    await dialog.getByRole('button', { name: 'Back', exact: true }).click();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    dialog = await preview(page, 'nested.zip');
    await dialog.getByRole('button', { name: 'inner/archive.zip', exact: true }).click();
    await dialog.getByRole('button', { name: 'image.png', exact: true }).click();
    await expect(dialog.locator('.attachment-image img')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    for (const name of ['encrypted.zip', 'unsafe-path.zip', 'large-entry.zip', 'too-many.zip']) {
      dialog = await preview(page, name);
      await expect(dialog).toContainText(name === 'encrypted.zip' ? 'Encrypted archive entries' : 'safety or resource limit');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    }
  });

  test('HTML, SVG, DOCX and EML remain passive with no tracking requests', async ({ page, fixtureApi }) => {
    await fixtureApi;
    const tracking: string[] = [];
    page.on('request', request => { if (request.url().includes('attachment-tracker.example.test')) tracking.push(request.url()); });
    await attachmentMessage(page, ['document.html', 'hostile.svg', 'external-document.docx', 'message.eml']);
    let dialog = await preview(page, 'document.html');
    await expect(dialog.locator('iframe').contentFrame().locator('body')).toContainText('Safe HTML fixture');
    await expect(dialog.locator('iframe')).toHaveAttribute('sandbox', 'allow-same-origin');
    await expect(dialog.locator('iframe').contentFrame().locator('script')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    dialog = await preview(page, 'hostile.svg');
    await expect(dialog.locator('.attachment-image img')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    dialog = await preview(page, 'external-document.docx');
    await expect(dialog.locator('iframe').contentFrame().locator('body')).toContainText('Inboxora DOCX preview');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    dialog = await preview(page, 'message.eml');
    await expect(dialog.locator('iframe').contentFrame().locator('body')).toContainText('EML safe body');
    const pending = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download inner.txt', exact: true }).click();
    expect((await pending).suggestedFilename()).toBe('inner.txt');
    expect(tracking).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, '__attachmentExecuted'))).toBeUndefined();
  });

  test('Escape inside an HTML frame returns to the message', async ({ page, fixtureApi }) => {
    await fixtureApi;
    await attachmentMessage(page, ['document.html']);
    const dialog = await preview(page, 'document.html');
    const body = dialog.locator('iframe').contentFrame().locator('body');
    await expect(body).toContainText('Safe HTML fixture');
    await body.click(); await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('text and image copying use the clipboard and PDF printing prepares every page', async ({ page, fixtureApi, context }) => {
    await fixtureApi;
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await attachmentMessage(page, ['text.txt', 'image.png', 'hundred-pages.pdf']);
    let dialog = await preview(page, 'text.txt');
    await dialog.getByRole('button', { name: 'Copy source', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Zażółć gęślą jaźń');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    dialog = await preview(page, 'image.png');
    await expect(dialog.locator('.attachment-image img')).toBeVisible();
    await dialog.getByRole('button', { name: 'Copy image', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.read()).flatMap(item => item.types))).toContain('image/png');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(() => {
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof HTMLIFrameElement && node.classList.contains('attachment-print-frame')) node.addEventListener('load', () => {
            if (node.contentWindow) node.contentWindow.print = () => { Reflect.set(window, '__attachmentPrintPages', node.contentDocument?.images.length); };
          }, { once: true });
        }
      }).observe(document.body, { childList: true });
    });
    dialog = await preview(page, 'hundred-pages.pdf');
    await dialog.getByRole('button', { name: 'Print', exact: true }).click();
    await expect.poll(() => page.evaluate(() => Reflect.get(window, '__attachmentPrintPages')), { timeout: 30000 }).toBe(100);
  });

  test('event and contact cards import only selected records into writable local collections', async ({ page, fixtureApi }) => {
    await fixtureApi;
    const imports: Array<{ path: string; body: Record<string, string> }> = [];
    await page.route('**/api/contacts/address-books', route => route.fulfill({ json: { addressBooks: [
      { id: 'local-book', name: 'Local book', source: 'local', read_only: false },
      { id: 'remote-book', name: 'Remote book', source: 'carddav', read_only: true },
    ] } }));
    await page.route('**/api/**/import/*', route => {
      imports.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
      return route.fulfill({ status: 201, json: { imported: 1 } });
    });
    await attachmentMessage(page, ['events.ics', 'contacts.vcf']);
    let dialog = await preview(page, 'events.ics');
    await expect(dialog.locator('.attachment-card')).toHaveCount(2);
    await dialog.getByRole('checkbox').first().check();
    await dialog.getByRole('combobox').selectOption('calendar-personal');
    await dialog.getByRole('button', { name: 'Add to calendar', exact: true }).click();
    await expect(dialog).toContainText('Selected items imported');
    expect(imports).toHaveLength(1); expect(imports[0].body.ics).toContain('UID:preview-event-1');
    expect(imports[0].body.ics).not.toContain('UID:preview-event-2');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    dialog = await preview(page, 'contacts.vcf');
    await expect(dialog.locator('.attachment-card')).toHaveCount(2);
    await expect(dialog.getByRole('combobox').locator('option')).toHaveCount(2);
    await dialog.getByRole('checkbox').last().check();
    await dialog.getByRole('combobox').selectOption('local-book');
    await dialog.getByRole('button', { name: 'Add to contacts', exact: true }).click();
    await expect(dialog).toContainText('Selected items imported');
    expect(imports).toHaveLength(2); expect(imports[1].body.vcard).toContain('UID:preview-contact-2');
  });

  test('native media has controls and a readable codec fallback', async ({ page, fixtureApi }) => {
    await fixtureApi;
    const names = ['audio.wav', 'audio.mp3', 'audio.ogg', 'video.webm', 'video.mp4'];
    await attachmentMessage(page, names);
    for (const name of names) {
      const dialog = await preview(page, name);
      await expect.poll(async () => {
        const media = dialog.locator('audio,video');
        if (await media.count()) return media.evaluate(element => (element as HTMLMediaElement).readyState > 0 ? 'ready' : 'loading');
        return await dialog.getByRole('alert').count() ? 'fallback' : 'loading';
      }).not.toBe('loading');
      const media = dialog.locator('audio,video');
      if (await media.count()) {
        await expect(media).toHaveAttribute('controls', '');
        expect(await media.evaluate(element => (element as HTMLMediaElement).paused)).toBe(true);
      } else await expect(dialog).toContainText('Download it to use another player');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    }
  });

  test('download-only formats stay available, and dangerous downloads require confirmation', async ({ page, fixtureApi }) => {
    await fixtureApi;
    const names = ['presentation.pptx', 'legacy.doc', 'legacy.ppt', 'document.odt', 'presentation.odp', 'unknown.bin'];
    await attachmentMessage(page, [...names, 'script.sh']);
    const downloads: string[] = []; page.on('download', download => downloads.push(download.suggestedFilename()));
    for (const name of names) {
      const dialog = await preview(page, name);
      await expect(dialog).toContainText('Preview is not available for this format');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    }
    expect(downloads).toEqual([]);
    const dialog = await preview(page, 'script.sh');
    await expect(dialog.locator('pre')).toContainText('Passive attachment fixture');
    await dialog.getByRole('button', { name: 'Download', exact: true }).click();
    const warning = page.getByTestId('attachment-dangerous-dialog');
    await expect(warning).toBeVisible(); expect(downloads).toEqual([]);
    await page.keyboard.press('Escape'); await expect(warning).toHaveCount(0); await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Download', exact: true }).click();
    const downloaded = page.waitForEvent('download');
    await warning.getByRole('button', { name: /Download/i }).click();
    expect((await downloaded).suggestedFilename()).toBe('script.sh');
  });

  for (const theme of ['light', 'dark']) test(`overlay and floating windows retain the selected image in ${theme} theme`, async ({ page, fixtureApi, isMobile }) => {
    await fixtureApi;
    await attachmentMessage(page, ['image.png', 'second.png', 'text.txt'], { theme });
    const dialog = await preview(page, 'image.png');
    await expect(dialog.locator('.attachment-image img')).toBeVisible();
    await page.screenshot({ path: `artifacts/attachment-${theme}-${isMobile ? 'mobile' : 'desktop'}.png` });
    const bounds = await dialog.boundingBox(); const viewport = page.viewportSize()!;
    expect(bounds!.width).toBeLessThanOrEqual(viewport.width + 1); expect(bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
    if (isMobile) {
      await expect(dialog.getByRole('button', { name: 'Open in window', exact: true })).toHaveCount(0);
      await page.evaluate(() => Reflect.get(window, '__inboxoraHandleAndroidBack')());
      await expect(dialog).toHaveCount(0);
    } else {
      await dialog.getByRole('button', { name: 'Next image', exact: true }).click();
      await expect(dialog.locator('.attachment-image img')).toHaveAttribute('alt', 'second.png');
      await dialog.getByRole('button', { name: 'Open in window', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const floating = page.locator('.mailflow-window').filter({ has: page.getByTestId('attachment-preview-surface') });
      await expect(floating.locator('.attachment-image img')).toHaveAttribute('alt', 'second.png');
      await floating.getByRole('button', { name: 'Minimize', exact: true }).click();
      await expect(floating).toHaveCount(0);
      await page.locator('.mailflow-window-min').getByRole('button', { name: 'second.png', exact: true }).click();
      await expect(floating.locator('.attachment-image img')).toHaveAttribute('alt', 'second.png');
      await floating.getByRole('button', { name: 'Close', exact: true }).click();
    }
  });
});
