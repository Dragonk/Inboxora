import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';
import { attachmentMessage, fileBytes } from './attachment-fixtures.ts';

async function contentMenu(page: Page, paragraph: Locator, select = true) {
  await paragraph.scrollIntoViewIfNeeded();
  await paragraph.evaluate((element, shouldSelect) => {
    const doc = element.ownerDocument; const selection = doc.getSelection(); selection?.removeAllRanges();
    if (shouldSelect) { const range = doc.createRange(); range.selectNodeContents(element); selection?.addRange(range); }
  }, select);
  await paragraph.click({ button: 'right' });
  const menu = page.getByTestId('message-context-menu'); await expect(menu).toBeVisible();
  await expect.poll(() => menu.evaluate(element => { const r = element.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; })).toBe(true);
  return menu;
}

for (const { grouped, scale } of [{ grouped: false, scale: 100 }, { grouped: true, scale: 100 }, { grouped: true, scale: 150 }]) test(`mail content Copy, select all, find and metadata copy use the displayed frame (grouped=${grouped}, scale=${scale})`, async ({ page, fixtureApi, context, isMobile }) => {
  test.skip(isMobile, 'Touch keeps the native selection menu, covered separately.');
  await fixtureApi; await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  page.__preferencesOverride = { fontSize: scale };
  await attachmentMessage(page, ['text.txt'], { grouped });
  const frame = page.locator('[data-message-detail-body] iframe:visible').first().contentFrame();
  const paragraph = frame.locator('p').first(); await expect(paragraph).toContainText('Attachment message body');
  let menu = await contentMenu(page, paragraph);
  await menu.getByText('Copy', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Attachment message body');
  menu = await contentMenu(page, paragraph);
  await menu.getByText('Copy subject', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Gmail reply chain');
  menu = await contentMenu(page, paragraph);
  await menu.getByText("Copy sender's address", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('sender@gmail.test');
  menu = await contentMenu(page, paragraph, false);
  await menu.getByText('Select all', { exact: true }).click();
  expect(await paragraph.evaluate(element => element.ownerDocument.getSelection()?.toString())).toContain('Attachment message body');
  menu = await contentMenu(page, paragraph);
  await menu.getByText('Find', { exact: true }).click();
  const find = page.getByTestId('message-body-find'); await expect(find).toBeVisible();
  await find.getByRole('textbox').fill('message'); await find.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(find.getByRole('status')).toHaveText('1 of 1');
  expect(await paragraph.evaluate(element => element.ownerDocument.getSelection()?.toString())).toBe('message');
  await find.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(() => {
    const open = window.open.bind(window);
    window.open = (...args) => {
      const child = open(...args);
      if (child) child.print = () => { Reflect.set(window, '__printedMessage', child.document.body.textContent); child.close(); };
      return child;
    };
  });
  menu = await contentMenu(page, paragraph); await menu.getByText('Print', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__printedMessage'))).toContain('Attachment message body');
  const clipboard = await page.evaluateHandle(() => navigator.clipboard);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
  menu = await contentMenu(page, paragraph); await menu.getByText('Copy', { exact: true }).click();
  await expect.poll(() => clipboard.evaluate(value => value.readText())).toBe('Attachment message body');
  await clipboard.dispose();
});

test('composer preserves the native edit menu and real copy, cut, paste, undo and redo', async ({ page, fixtureApi, context }) => {
  await fixtureApi; await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await attachmentMessage(page, ['text.txt']);
  await page.getByRole('button', { name: 'Compose', exact: true }).first().click();
  const editor = page.locator('.tiptap-compose [contenteditable=true]').first();
  await editor.fill('Composer clipboard fixture');
  await editor.press('ControlOrMeta+a');
  expect(await editor.evaluate(element => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    element.dispatchEvent(event); return event.defaultPrevented;
  })).toBe(false);
  await editor.press('ControlOrMeta+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Composer clipboard fixture');
  // Separate the initial typing group from Cut in ProseMirror's 500ms history window.
  await page.waitForTimeout(550);
  await editor.press('ControlOrMeta+x'); await expect(editor).not.toContainText('Composer clipboard fixture');
  await editor.press('ControlOrMeta+z'); await expect(editor).toContainText('Composer clipboard fixture');
  await editor.press('ControlOrMeta+Shift+z'); await expect(editor).not.toContainText('Composer clipboard fixture');
  await editor.press('ControlOrMeta+v'); await expect(editor).toContainText('Composer clipboard fixture');
});

for (const copyNumber of [1, 2]) test(`received/sent context flags target the exact physical copy ${copyNumber}`, async ({ page, fixtureApi, context, isMobile }) => {
  test.skip(isMobile, 'Desktop menu; touch uses native selection.');
  await fixtureApi; await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await attachmentMessage(page, ['text.txt'], { grouped: true });
  const id = `conversation-gmail-copy-${copyNumber}`;
  const card = page.locator(`article[data-physical-copy-id="${id}"]`);
  if (await card.getAttribute('data-conversation-message-state') !== 'expanded') await card.locator('[data-conversation-message-toggle]').click();
  const paragraph = card.locator('iframe').contentFrame().locator('p').first();
  let menu = await contentMenu(page, paragraph);
  await menu.getByText('Star message', { exact: true }).click();
  await expect.poll(() => page.__starActions.at(-1)).toEqual({ id, body: { starred: true } });
  menu = await contentMenu(page, paragraph); await menu.getByText('Mark as unread', { exact: true }).click();
  await expect.poll(() => page.__bulkReadActions.at(-1)).toEqual({ ids: [id], read: false });
  menu = await contentMenu(page, paragraph); await menu.getByText('Copy', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Attachment message body');
  menu = await contentMenu(page, paragraph); await menu.getByText("Copy sender's address", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(copyNumber === 2 ? 'me@gmail.test' : 'sender@gmail.test');
});

test('conversation context snooze, category and block actions dispatch for the opened copy', async ({ page, fixtureApi, isMobile }) => {
  test.skip(isMobile, 'Desktop context actions; native touch selection remains unchanged.');
  await fixtureApi; page.__preferencesOverride = { categorizationEnabled: true };
  await attachmentMessage(page, ['text.txt'], { grouped: true });
  const paragraph = page.locator('article[data-physical-copy-id="conversation-gmail-copy-5"] iframe').contentFrame().locator('p').first();
  const writes: Array<{ path: string; body: unknown }> = [];
  await page.route(url => /\/api\/(block-list|mail\/messages\/[^/]+\/(snooze|category))$/.test(url.pathname), route => {
    writes.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    return route.fulfill({ json: { ok: true } });
  });
  let menu = await contentMenu(page, paragraph);
  await menu.getByText('Snooze', { exact: true }).click(); await menu.getByText('In 3 hours', { exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ path: '/api/mail/messages/conversation-gmail-copy-5/snooze' });
  menu = await contentMenu(page, paragraph);
  await menu.getByText('Add to block list', { exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({ path: '/api/block-list', body: { emailAddress: 'sender@gmail.test' } });
  menu = await contentMenu(page, paragraph);
  await menu.getByText('Categorize as…', { exact: true }).click();
  await menu.getByText('Newsletters', { exact: true }).click();
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2]).toEqual({ path: '/api/mail/messages/conversation-gmail-copy-5/category', body: { category: 'newsletter' } });
});
