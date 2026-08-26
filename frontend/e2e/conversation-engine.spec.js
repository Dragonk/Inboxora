import { test, expect } from './fixtures.js';

async function open(page, fixtureApi, grouped, reader, { invalidTarget = false } = {}) {
  await fixtureApi;
  page.__conversationMatrix = `${Number(grouped)}${Number(reader)}`;
  page.__invalidConversationTarget = invalidTarget;
  const listLoaded = page.waitForResponse(response => {
    if (response.request().method() !== 'GET' || !response.ok()) return false;
    const pathname = new URL(response.url()).pathname;
    return pathname === '/api/mail/messages';
  });
  await page.goto(`/?list=${Number(grouped)}&reader=${Number(reader)}`, { waitUntil: 'domcontentloaded' });
  await listLoaded;
  await expect(page.locator('[data-ce-reader-enabled]:visible').first()).toBeVisible();
}

test.describe('native conversation engine matrix', () => {
  test('OFF/OFF uses the flat message list and opens the native single MessagePane', async ({ page, fixtureApi }) => {
    await open(page, fixtureApi, false, false);
    await page.locator('[data-msgid="conversation-gmail-copy-1"]:visible').click();
    await expect(page.locator('[data-testid="message-pane-toolbar"]:visible')).toBeVisible();
    await expect(page.locator('section[data-conversation-id]:visible')).toHaveCount(0);
  });

  test('OFF/ON resolves a flat selected physical message into its conversation (release blocker)', async ({ page, fixtureApi }) => {
    await open(page, fixtureApi, false, true);
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    const reader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
    await expect(reader).toBeVisible();
    await expect(reader.locator('#logical-message-conversation-gmail-logical-1')).toBeVisible();
    await expect(reader.locator('[data-conversation-message-state="collapsed"]')).toHaveCount(4);
    await expect(reader.locator('[data-conversation-message-state="expanded"]')).toHaveCount(1);
    await expect(reader.locator('#logical-message-conversation-gmail-logical-2')).toHaveAttribute('data-conversation-message-state', 'expanded');
    await reader.locator('#logical-message-conversation-gmail-logical-3 [data-conversation-message-toggle="true"][aria-expanded="false"]').click();
    await expect(reader.locator('#logical-message-conversation-gmail-logical-3')).toHaveAttribute('data-conversation-message-state', 'expanded');
    await expect(reader.locator('#logical-message-conversation-gmail-logical-2')).toHaveAttribute('data-conversation-message-state', 'expanded');
    await expect(reader.locator('[data-conversation-message-state="expanded"]')).toHaveCount(2);
    await expect(reader.locator('#logical-message-conversation-gmail-logical-3 iframe')).toBeVisible();
    await expect(reader.locator('#logical-message-conversation-gmail-logical-3 iframe').contentFrame().locator('body')).toContainText('Fixture body lazy conversation-gmail-copy-3');
    await reader.locator('#logical-message-conversation-gmail-logical-2 [data-conversation-message-toggle="true"][aria-expanded="true"]').click();
    await expect(reader.locator('#logical-message-conversation-gmail-logical-2')).toHaveAttribute('data-conversation-message-state', 'collapsed');
    await expect(reader.locator('#logical-message-conversation-gmail-logical-3')).toHaveAttribute('data-conversation-message-state', 'expanded');
    await reader.locator('#logical-message-conversation-gmail-logical-3 [data-conversation-message-toggle="true"][aria-expanded="true"]').click();
    await expect(reader.locator('#logical-message-conversation-gmail-logical-3')).toHaveAttribute('data-conversation-message-state', 'collapsed');
    await expect(reader.locator('[data-conversation-message-state="expanded"]')).toHaveCount(0);
    await page.screenshot({ path: 'artifacts/off-on.png', fullPage: true });
  });

  test('OFF/ON falls back to the newest message when the resolver target is stale', async ({ page, fixtureApi }) => {
    await open(page, fixtureApi, false, true, { invalidTarget: true });
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    const reader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
    await expect(reader.locator('[data-conversation-message-state="expanded"]')).toHaveCount(1);
    await expect(reader.locator('#logical-message-conversation-gmail-logical-5')).toHaveAttribute('data-conversation-message-state', 'expanded');
  });

  test('ON/OFF retains the native threaded list and selects its parent message', async ({ page, fixtureApi }) => {
    await open(page, fixtureApi, true, false);
    const parent = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
    await expect(parent).toBeVisible();
    expect(await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name))).toEqual(
      expect.arrayContaining([expect.stringMatching(/\/api\/mail\/messages\?[^#]*threaded=true/)]),
    );
    await parent.getByRole('button', { name: /\(5\)/ }).click();
    const directions = parent.locator('xpath=..').locator('[data-message-direction]');
    // P1-D: first direction is the parent arrow for the newest unique child; the
    // remaining five are the exact expanded native children.
    await expect(directions).toHaveCount(6);
    await expect(parent).toHaveAttribute('data-thread-parent-direction', 'incoming');
    await expect(directions.nth(0)).toHaveAttribute('data-message-direction', 'incoming');
    await expect(directions.nth(1)).toHaveAttribute('data-message-direction', 'incoming');
    await expect(directions.nth(2)).toHaveAttribute('data-message-direction', 'outgoing');
    await expect(directions.nth(3)).toHaveAttribute('data-message-direction', 'incoming');
    await page.screenshot({ path: 'artifacts/on-off-expanded.png', fullPage: true });
    await parent.click();
    await expect(page.locator('[data-testid="message-pane-toolbar"]:visible')).toBeVisible();
  });

  test('ON/ON opens compact cards and replies against the expanded message', async ({ page, fixtureApi }) => {
    await open(page, fixtureApi, true, true);
    await page.locator('[data-msgid="conversation-gmail-copy-5"]:visible').click();
    const reader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
    await expect(reader).toBeVisible();
    await expect(reader).toHaveAttribute('data-selected-copy-id', 'conversation-gmail-copy-5');
    await expect(reader).toHaveAttribute('data-selected-account-id', 'account-gmail');
    await expect(reader.locator('[data-conversation-message-state="collapsed"]')).toHaveCount(4);
    await expect(reader.locator('[data-conversation-message-state="expanded"]')).toHaveCount(1);
    const collapsed = reader.locator('#logical-message-conversation-gmail-logical-1');
    await expect(collapsed.locator('[data-conversation-message-snippet="true"]')).toBeVisible();
    await expect(collapsed.locator('[data-conversation-message-actions="true"]')).toHaveCount(0);
    await expect(collapsed.locator('[data-conversation-message-expanded-content="true"]')).toHaveCount(0);
    await expect(collapsed.locator('[data-conversation-message-attachments="true"]')).toHaveCount(0);
    await page.screenshot({ path: 'artifacts/on-on-initial.png', fullPage: true });
    const latest = reader.locator('[data-logical-message-id="conversation-gmail-logical-5"]');
    await expect(latest.locator('[data-conversation-message-actions="true"]')).toBeVisible();
    await expect(latest.locator('[data-conversation-message-snippet="true"]')).toHaveCount(0);
    await expect(latest.locator('[data-conversation-message-expanded-content="true"]')).toBeVisible();
    // Resolver selected copy 5 on Gmail. The newest physical message is incoming,
    // while stale logical direction disagrees; physical account identity wins.
    await expect(latest.locator('[data-message-direction="incoming"]')).toBeVisible();
    await reader.locator('#logical-message-conversation-gmail-logical-2 [data-conversation-message-toggle="true"][aria-expanded="false"]').evaluate(button => button.click());
    await expect(reader.locator('#logical-message-conversation-gmail-logical-2')).toHaveAttribute('data-conversation-message-state', 'expanded');
    await expect(latest).toHaveAttribute('data-conversation-message-state', 'expanded');
    await expect(reader.locator('[data-conversation-message-state="expanded"]')).toHaveCount(2);
    await expect(reader.locator('[data-conversation-message-actions="true"]')).toHaveCount(2);
    await expect(reader.locator('[data-conversation-message-toggle="true"] [data-conversation-message-actions="true"]')).toHaveCount(0);
    await expect(reader.locator('#logical-message-conversation-gmail-logical-2 [data-conversation-message-actions="true"][data-action-target-id="conversation-gmail-logical-2"]')).toBeVisible();
    await expect(latest.locator('[data-conversation-message-actions="true"][data-action-target-id="conversation-gmail-logical-5"]')).toBeVisible();
    await page.screenshot({ path: 'artifacts/on-on-after-switch-expanded.png', fullPage: true });
    const second = reader.locator('#logical-message-conversation-gmail-logical-2');
    // Exercise toolbar actions before opening the reply composer. On a mobile
    // viewport the composer is intentionally modal and intercepts the reader.
    for (const [action, expectedPath] of [['star', '/star'], ['unread', '/read'], ['delete', '/delete']]) {
      const directAction = second.locator(`[data-message-action="${action}"]`);
      if (action === 'unread' && await directAction.count() === 0) {
        // The mobile toolbar intentionally puts read/unread inside the More menu.
        await second.locator('[data-message-action="more"]').click();
        await second.getByRole('button', { name: /Oznacz jako nieprzeczytane|Mark unread/i }).click();
      } else {
        await directAction.click();
      }
      await expect.poll(() => page.__conversationActions.at(-1)?.url).toContain(expectedPath);
      await expect.poll(() => page.__conversationActions.at(-1)?.body).toMatchObject({
        scope: 'THIS_COPY', copyId: 'conversation-gmail-copy-2', logicalMessageId: 'conversation-gmail-logical-2',
      });
      await expect(second).toHaveAttribute('data-conversation-message-state', 'expanded');
    }
    await second.locator('[data-message-action="archive"]').evaluate(button => button.click());
    await expect(second).toHaveAttribute('data-conversation-message-state', 'expanded');
    await expect(latest).toHaveAttribute('data-conversation-message-state', 'expanded');
    await expect.poll(() => page.__conversationActions.at(-1)).toMatchObject({
      method: 'POST',
      body: { scope: 'THIS_COPY', copyId: 'conversation-gmail-copy-2', logicalMessageId: 'conversation-gmail-logical-2' },
    });
    await second.locator('[data-message-action="reply"]').evaluate(button => button.click());
    await expect(reader.locator('[data-conversation-message-actions="true"]')).toHaveCount(2);
    await expect(second).toHaveAttribute('data-conversation-message-state', 'expanded');
  });
  test('ON/ON expanded native child rows expose per-message incoming/outgoing direction', async ({ page, fixtureApi }) => {
    await open(page, fixtureApi, true, true);
    const parent = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
    await parent.getByRole('button', { name: /\(5\)/ }).click();
    const directions = parent.locator('xpath=..').locator('[data-message-direction]');
    // Parent latest direction + five native child directions.
    await expect(directions).toHaveCount(6);
    await expect(parent).toHaveAttribute('data-thread-parent-direction', 'incoming');
    await expect(directions.nth(1)).toHaveAttribute('data-message-direction', 'incoming');
    await expect(directions.nth(4)).toHaveAttribute('data-message-direction', 'outgoing');
    await expect(directions.nth(5)).toHaveAttribute('data-message-direction', 'incoming');
  });

  test('ON/ON exposes a terminal no-copy state without actions or body retries', async ({ page, fixtureApi }) => {
    await open(page, fixtureApi, true, true);
    page.__unknownConversationAccount = true;
    let bodyRequests = 0;
    page.on('request', request => {
      if (/\/logical-messages\/[^/]+\/body(?:\?|$)/.test(request.url())) bodyRequests += 1;
    });
    await page.locator('[data-msgid="conversation-gmail-copy-5"]:visible').click();
    const reader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
    await expect(reader).toHaveAttribute('data-selected-account-id', 'account-unknown');
    const expanded = reader.locator('#logical-message-conversation-gmail-logical-5');
    await expect(expanded).toHaveAttribute('data-conversation-message-state', 'expanded');
    await expect(expanded.getByRole('status')).toContainText(/brak|no message body/i);
    await expect(expanded.locator('[data-conversation-message-actions="true"]')).toHaveCount(0);
    await expect(expanded.locator('[data-conversation-message-attachments="true"]')).toHaveCount(0);
    expect(bodyRequests).toBe(0);
  });

  test('reader keeps all native children when CE detail is incomplete', async ({ page, fixtureApi }) => {
    page.__ceIncomplete = true;
    await open(page, fixtureApi, false, true);
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    const reader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
    await expect(reader.locator('article')).toHaveCount(5);
    await expect(reader.locator('[data-conversation-message-state="collapsed"]')).toHaveCount(4);
    await expect(reader.locator('[data-conversation-message-state="expanded"]')).toHaveCount(1);
  });

  test('mobile reader cards use native MessagePane width without desktop side padding', async ({ page, fixtureApi }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith('chromium-mobile'), 'mobile viewport contract');
    await open(page, fixtureApi, false, false);
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    const nativeWidth = await page.locator('[data-testid="message-pane-toolbar"]:visible').evaluate(element => element.parentElement.getBoundingClientRect().width);
    await page.goBack();
    await open(page, fixtureApi, false, true);
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    const reader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
    const card = reader.locator('article').first();
    const [readerWidth, cardWidth, viewportWidth] = await Promise.all([
      reader.evaluate(element => element.getBoundingClientRect().width),
      card.evaluate(element => element.getBoundingClientRect().width),
      page.evaluate(() => window.innerWidth),
    ]);
    // Reader/root/card consume the same pane width; mobile card has no 28px desktop sides.
    expect(readerWidth).toBeGreaterThanOrEqual(nativeWidth - 1);
    expect(cardWidth).toBeGreaterThanOrEqual(viewportWidth - 2);
    expect(viewportWidth).toBeGreaterThanOrEqual(390);
  });

  test('plain HTML reply marker folds one historical region and iframe shrinks after collapse', async ({ page, fixtureApi }) => {
    page.__plainQuoteFoldingCopy = 'conversation-gmail-copy-2';
    await open(page, fixtureApi, false, true);
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    const frame = page.locator('#logical-message-conversation-gmail-logical-2 iframe').contentFrame();
    const iframe = page.locator('#logical-message-conversation-gmail-logical-2 iframe');
    await expect(frame.locator('[data-testid="current-content"]')).toBeVisible();
    await expect(frame.locator('[data-testid="plain-reply-marker"]')).toBeHidden();
    await expect(frame.locator('.mailflow-quote-toggle')).toHaveCount(1);
    const h1 = await iframe.evaluate(element => element.getBoundingClientRect().height);
    await frame.locator('.mailflow-quote-toggle').click();
    await expect(frame.locator('[data-testid="plain-reply-marker"]')).toBeVisible();
    const h2 = await iframe.evaluate(element => element.getBoundingClientRect().height);
    expect(h2).toBeGreaterThan(h1);
    await frame.locator('.mailflow-quote-toggle').click();
    await expect(frame.locator('[data-testid="plain-reply-marker"]')).toBeHidden();
    await expect.poll(() => iframe.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(h2);
  });

  test('remote images share blocked/allowed behavior and preserve CID/data sources', async ({ page, fixtureApi }) => {
    let remoteRequests = 0;
    await page.route('https://example.test/signature.png', route => {
      remoteRequests += 1;
      return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"/>' });
    });
    await open(page, fixtureApi, false, true);
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    const card = page.locator('#logical-message-conversation-gmail-logical-2');
    const frame = card.locator('iframe').contentFrame();
    const remote = frame.locator('[data-testid="remote-signature"]');
    await expect(remote).toHaveAttribute('data-mailflow-remote-blocked', 'true');
    await expect(remote).toHaveAttribute('data-mailflow-remote-src', 'https://example.test/signature.png');
    await expect(frame.locator('[data-testid="cid-image"]')).toHaveAttribute('src', 'cid:fixture');
    await expect(frame.locator('[data-testid="data-image"]')).toHaveAttribute('src', /^data:image\/gif/);
    expect(remoteRequests).toBe(0);
    await card.getByRole('button', { name: /wczytaj obrazy|load images/i }).click();
    await expect(card.locator('iframe').contentFrame().locator('[data-testid="remote-signature"]')).toHaveAttribute('src', 'https://example.test/signature.png');
    await expect.poll(() => remoteRequests).toBe(1);
  });

  test('physical-copy body state survives out-of-order responses and collapse/re-expand', async ({ page, fixtureApi }) => {
    page.__bodyResponseDelays = { 'conversation-gmail-copy-1': 350, 'conversation-gmail-copy-2': 50 };
    await open(page, fixtureApi, false, true);
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    const reader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
    const first = reader.locator('#logical-message-conversation-gmail-logical-1');
    const second = reader.locator('#logical-message-conversation-gmail-logical-2');
    await first.locator('[data-conversation-message-toggle="true"]').click();
    await expect(second.locator('iframe').contentFrame().locator('body')).toContainText('conversation-gmail-copy-2');
    await expect(first.locator('iframe').contentFrame().locator('body')).toContainText('conversation-gmail-copy-1');
    await first.locator('[data-conversation-message-toggle="true"]').click();
    await first.locator('[data-conversation-message-toggle="true"]').click();
    await expect(first.locator('iframe').contentFrame().locator('body')).toContainText('conversation-gmail-copy-1');
    await expect(second.locator('iframe').contentFrame().locator('body')).toContainText('conversation-gmail-copy-2');
  });

  test('hierarchical quote folding keeps forward envelope and immediate body visible but collapses nested reply history', async ({ page, fixtureApi }) => {
    page.__quoteFoldingCopy = 'conversation-gmail-copy-2';
    await open(page, fixtureApi, false, true);
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    const card = page.locator('#logical-message-conversation-gmail-logical-2');
    await expect(card.locator('iframe')).toBeVisible();
    const frame = card.locator('iframe').contentFrame();
    // Current authored content is visible.
    await expect(frame.locator('[data-testid="current-content"]')).toBeVisible();
    // Forward envelope/header is visible (not collapsed).
    await expect(frame.locator('[data-testid="forward-envelope"]')).toBeVisible();
    await expect(frame.locator('text=---------- Forwarded message ---------')).toBeVisible();
    // Immediate forwarded body content is visible.
    await expect(frame.locator('[data-testid="forwarded-content"]')).toBeVisible();
    // Nested reply history inside the forwarded body is collapsed behind a toggle.
    await expect(frame.locator('[data-testid="nested-reply"]')).toBeHidden();
    await expect(frame.locator('[data-testid="old-reply"]')).toBeHidden();
    // Expanding the nested quote reveals the old reply.
    await frame.locator('.mailflow-quote-toggle').first().click();
    await expect(frame.locator('[data-testid="old-reply"]')).toBeVisible();
  });

  test('dark theme body surface uses the native dark content surface, not white', async ({ page, fixtureApi }) => {
    page.__themeOverride = 'dark';
    await open(page, fixtureApi, true, true);
    await page.locator('[data-msgid="conversation-gmail-copy-5"]:visible').click();
    const card = page.locator('#logical-message-conversation-gmail-logical-5');
    const panel = card.locator('.conversation-message-body-panel');
    const bg = await panel.evaluate(element => getComputedStyle(element).backgroundColor);
    // Dark surface must not be white.
    expect(bg).not.toBe('rgb(255, 255, 255)');
  });

});
