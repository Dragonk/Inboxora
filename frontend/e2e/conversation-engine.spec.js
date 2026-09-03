import { test, expect } from './fixtures.js';

const isDesktopProject = testInfo => testInfo.project.name === 'chromium-desktop';
const isPortraitMobileProject = testInfo => ['chromium-mobile-390', 'chromium-mobile'].includes(testInfo.project.name);

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
  const list = page.locator('[data-ce-reader-enabled]:visible').first();
  await expect(list).toBeVisible();
  // The list response can arrive before preferences finish applying. Wait for the
  // requested matrix so a click is not handled by stale pre-preference behavior.
  await expect(list).toHaveAttribute('data-ce-reader-enabled', reader ? 'true' : 'false');
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

  test('OFF/ON marks an unread copy read when CE resolution falls back to the single pane', async ({ page, fixtureApi }, testInfo) => {
    test.skip(!isDesktopProject(testInfo), 'desktop fallback read-ownership contract');
    page.__conversationResolutionFails = true;
    page.__noNativeThread = true;
    page.__unreadCopies = ['conversation-gmail-copy-2'];
    await open(page, fixtureApi, false, true);
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    await expect(page.locator('[data-ce-resolution-error="true"]:visible').first()).toBeVisible();
    await expect(page.locator('[data-testid="message-pane-toolbar"]:visible')).toBeVisible();
    await expect.poll(() => page.__bulkReadActions).toEqual([{ ids: ['conversation-gmail-copy-2'], read: true }]);
  });

  test('OFF/ON falls back to the single pane when both CE resolution and native thread loading fail', async ({ page, fixtureApi }, testInfo) => {
    test.skip(!isDesktopProject(testInfo), 'desktop fallback source-unavailability contract');
    page.__conversationResolutionFails = true;
    page.__nativeThreadLoadFails = true;
    await open(page, fixtureApi, false, true);
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    await expect(page.locator('[data-ce-resolution-error="true"]:visible').first()).toBeVisible();
    await expect(page.locator('[data-testid="message-pane-toolbar"]:visible')).toBeVisible();
    await expect(page.locator('section[data-conversation-id]:visible')).toHaveCount(0);
  });

  test('OFF/ON falls back to the single pane when CE resolution fails and the native thread is empty', async ({ page, fixtureApi }, testInfo) => {
    test.skip(!isDesktopProject(testInfo), 'desktop empty-native-thread fallback contract');
    page.__conversationResolutionFails = true;
    page.__nativeThreadEmpty = true;
    await open(page, fixtureApi, false, true);
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    await expect(page.locator('[data-ce-resolution-error="true"]:visible').first()).toBeVisible();
    await expect(page.locator('[data-testid="message-pane-toolbar"]:visible')).toBeVisible();
    await expect(page.locator('section[data-conversation-id]:visible')).toHaveCount(0);
  });

  test('OFF/ON falls back to the single pane when CE resolution fails and the native thread payload is malformed', async ({ page, fixtureApi }, testInfo) => {
    test.skip(!isDesktopProject(testInfo), 'desktop malformed-native-thread fallback contract');
    page.__conversationResolutionFails = true;
    page.__nativeThreadMalformed = true;
    await open(page, fixtureApi, false, true);
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    await expect(page.locator('[data-ce-resolution-error="true"]:visible').first()).toBeVisible();
    await expect(page.locator('[data-testid="message-pane-toolbar"]:visible')).toBeVisible();
    await expect(page.locator('section[data-conversation-id]:visible')).toHaveCount(0);
  });

  test('OFF/ON cancels a delayed fallback mark-read when selection changes', async ({ page, fixtureApi }, testInfo) => {
    test.skip(!isDesktopProject(testInfo), 'desktop delayed fallback read-ownership contract');
    await page.addInitScript(() => {
      localStorage.setItem('mailflow_mark_read_behavior', 'delay');
      localStorage.setItem('mailflow_mark_read_delay', '1');
    });
    page.__conversationResolutionFails = true;
    page.__noNativeThread = true;
    page.__unreadCopies = ['conversation-gmail-copy-1', 'conversation-gmail-copy-2'];
    await open(page, fixtureApi, false, true);
    await page.locator('[data-msgid="conversation-gmail-copy-1"]:visible').click();
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    await expect.poll(() => page.__bulkReadActions).toEqual([{ ids: ['conversation-gmail-copy-2'], read: true }]);
  });

  test('OFF/ON retains the selected physical message when the resolver target is stale', async ({ page, fixtureApi }) => {
    await open(page, fixtureApi, false, true, { invalidTarget: true });
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    const reader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
    await expect(reader.locator('[data-conversation-message-state="expanded"]')).toHaveCount(1);
    // A stale CE logical ID must not make an explicit physical-copy selection jump
    // to a different message. ConversationReader uses the selected physical copy as
    // the fallback target; the generic helper's newest-message fallback is for cases
    // where there is no physical selection at all.
    await expect(reader.locator('#logical-message-conversation-gmail-logical-2')).toHaveAttribute('data-conversation-message-state', 'expanded');
  });

  test('ON/OFF retains the native threaded list and selects its parent message', async ({ page, fixtureApi }, testInfo) => {
    test.skip(!isDesktopProject(testInfo), 'desktop parent-row selection contract');
    await open(page, fixtureApi, true, false);
    const parent = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
    await expect(parent).toBeVisible();
    expect(await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name))).toEqual(
      expect.arrayContaining([expect.stringMatching(/\/api\/mail\/messages\?[^#]*threaded=true/)]),
    );
    await parent.locator("button[aria-label*='(5)']").click();
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

  test('ON/ON opens compact cards and replies against the expanded message', async ({ page, fixtureApi }, testInfo) => {
    test.skip(!isDesktopProject(testInfo), 'mobile parent rows expand the list; child selection is covered separately');
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
    // Conversation mutations use the CE endpoint and are scoped to the selected
    // physical copy. Read state intentionally uses the shared per-copy bulk-read
    // lane instead, so assert that contract separately below.
    const starAction = second.locator('[data-message-action="star"]');
    await starAction.click();
    await expect.poll(() => page.__conversationActions.at(-1)?.url).toContain('/star');
    await expect.poll(() => page.__conversationActions.at(-1)?.body).toMatchObject({
      scope: 'THIS_COPY', copyId: 'conversation-gmail-copy-2', logicalMessageId: 'conversation-gmail-logical-2',
    });
    await expect(second).toHaveAttribute('data-conversation-message-state', 'expanded');
    const unreadAction = second.locator('[data-message-action="unread"]');
    if (await unreadAction.count() === 0) {
      // The mobile toolbar intentionally puts read/unread inside the More menu.
      await second.locator('[data-message-action="more"]').click();
      await second.getByRole('button', { name: /Oznacz jako nieprzeczytane|Mark unread/i }).click();
    } else {
      await unreadAction.click();
    }
    await expect.poll(() => page.__bulkReadActions.at(-1)).toEqual({ ids: ['conversation-gmail-copy-2'], read: false });
    await expect(second).toHaveAttribute('data-conversation-message-state', 'expanded');
    await second.locator('[data-message-action="reply"]').evaluate(button => button.click());
    await expect(reader.locator('[data-conversation-message-actions="true"]')).toHaveCount(2);
    await expect(second).toHaveAttribute('data-conversation-message-state', 'expanded');
    await second.locator('[data-message-action="archive"]').evaluate(button => button.click());
    await expect.poll(() => page.__conversationActions.at(-1)).toMatchObject({
      method: 'POST',
      body: { scope: 'THIS_COPY', copyId: 'conversation-gmail-copy-2', logicalMessageId: 'conversation-gmail-logical-2' },
    });
    await expect(second).toHaveCount(0);
    await latest.locator('[data-message-action="delete"]').click();
    await expect.poll(() => page.__conversationActions.at(-1)?.url).toContain('/delete');
    await expect.poll(() => page.__conversationActions.at(-1)?.body).toMatchObject({
      scope: 'THIS_COPY', copyId: 'conversation-gmail-copy-5', logicalMessageId: 'conversation-gmail-logical-5',
    });
    await expect(latest).toHaveCount(0);
    await expect(page.locator('[data-msgid="conversation-gmail-copy-5"]:visible')).toHaveCount(0);
  });
  test('ON/ON expanded native child rows expose per-message incoming/outgoing direction', async ({ page, fixtureApi }) => {
    await open(page, fixtureApi, true, true);
    const parent = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
    await parent.locator("button[aria-label*='(5)']").click();
    const directions = parent.locator('xpath=..').locator('[data-message-direction]');
    // Parent latest direction + five native child directions.
    await expect(directions).toHaveCount(6);
    await expect(parent).toHaveAttribute('data-thread-parent-direction', 'incoming');
    await expect(directions.nth(1)).toHaveAttribute('data-message-direction', 'incoming');
    await expect(directions.nth(4)).toHaveAttribute('data-message-direction', 'outgoing');
    await expect(directions.nth(5)).toHaveAttribute('data-message-direction', 'incoming');
  });


  test('ON/ON exposes a terminal no-copy state without actions or body retries', async ({ page, fixtureApi }, testInfo) => {
    test.skip(!isDesktopProject(testInfo), 'desktop parent-row selection contract');
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

  test('native membership excludes stale and ambiguous CE-only records', async ({ page, fixtureApi }, testInfo) => {
    test.skip(!isDesktopProject(testInfo), 'desktop parent-row selection contract');
    page.__ceMode = 'stale';
    await open(page, fixtureApi, true, true);
    const parent = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
    await expect(parent.locator("button[aria-label*='(5)']")).toBeVisible();
    await parent.locator("button[aria-label*='(5)']").click();
    const children = parent.locator('xpath=..').locator('[data-message-direction]');
    await expect(children).toHaveCount(6); // parent latest direction + five children
    await parent.click();
    const reader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
    await expect(reader).toHaveAttribute('data-reader-source', 'native-thread');
    await expect(reader.locator('article')).toHaveCount(5);
    await expect(reader.locator('article[data-physical-copy-id]')).toHaveCount(5);
    await expect(reader.locator('#logical-message-conversation-gmail-logical-stale')).toHaveCount(0);
    await expect(reader).not.toContainText('PLAC Broniewskiego');
  });

  test('native membership keeps an unmatched native copy and never adds duplicate CE identity', async ({ page, fixtureApi }) => {
    page.__ceMode = 'missing-n2';
    await open(page, fixtureApi, false, true);
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    const reader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
    await expect(reader.locator('article')).toHaveCount(5);
    const unmatched = reader.locator('article[data-physical-copy-id="conversation-gmail-copy-2"]');
    await expect(unmatched).toHaveCount(1);
    await expect(unmatched).not.toHaveAttribute('data-logical-message-id', /.+/);
  });

  test('ambiguous duplicate CE candidates still render exactly one native card', async ({ page, fixtureApi }) => {
    page.__ceMode = 'duplicate-n2';
    await open(page, fixtureApi, false, true);
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    const reader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
    await expect(reader.locator('article')).toHaveCount(5);
    const ambiguous = reader.locator('article[data-physical-copy-id="conversation-gmail-copy-2"]');
    await expect(ambiguous).toHaveCount(1);
    await expect(ambiguous).not.toHaveAttribute('data-logical-message-id', /.+/);
    await expect(reader.locator('#logical-message-conversation-gmail-logical-2-duplicate')).toHaveCount(0);
  });

  test('mobile reader cards use native MessagePane width without desktop side padding', async ({ page, fixtureApi }, testInfo) => {
    test.skip(!isPortraitMobileProject(testInfo), 'portrait mobile viewport contract');
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

  test('mobile newsletter HTML fits the iframe viewport without right-edge clipping', async ({ page, fixtureApi }, testInfo) => {
    test.skip(!isPortraitMobileProject(testInfo), 'portrait mobile viewport contract');
    page.__newsletterCopy = 'conversation-gmail-copy-2';
    await open(page, fixtureApi, false, true);
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    const iframe = page.locator('#logical-message-conversation-gmail-logical-2 iframe');
    const frame = iframe.contentFrame();
    await expect(frame.locator('[data-testid="newsletter-final-words"]')).toBeVisible();
    await expect(frame.locator('[data-testid="newsletter-banner"]')).toBeVisible();
    const metrics = await frame.locator('html').evaluate(element => ({
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
      bannerWidth: element.ownerDocument.querySelector('[data-testid="newsletter-banner"]').getBoundingClientRect().width,
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 2);
    expect(metrics.bannerWidth).toBeLessThanOrEqual(metrics.clientWidth);
    // iframe tracks the available MessagePane width (not an arbitrary viewport constant).
    expect(await iframe.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(0);
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

  test('dark theme body surface uses the native dark content surface, not white', async ({ page, fixtureApi }, testInfo) => {
    test.skip(!isDesktopProject(testInfo), 'desktop parent-row selection contract');
    page.__themeOverride = 'dark';
    await open(page, fixtureApi, true, true);
    await page.locator('[data-msgid="conversation-gmail-copy-5"]:visible').click();
    const card = page.locator('#logical-message-conversation-gmail-logical-5');
    const panel = card.locator('.conversation-message-body-panel');
    const bg = await panel.evaluate(element => getComputedStyle(element).backgroundColor);
    // Dark surface must not be white.
    expect(bg).not.toBe('rgb(255, 255, 255)');
  });

  test('renders 500 grouped rows without eager native-thread expansion and resolves one singleton only on tap', async ({ page, fixtureApi }, testInfo) => {
    test.skip(!isDesktopProject(testInfo), 'desktop parent-row selection contract');
    page.__largeMailboxRows = 500;
    let threadRequests = 0;
    page.on('request', request => {
      if (/\/api\/mail\/thread\//.test(request.url())) threadRequests += 1;
    });
    await open(page, fixtureApi, true, false);
    await expect(page.locator('[data-thread-row-parent="true"]:visible')).toHaveCount(500);
    expect(threadRequests).toBe(0);
    await page.locator('[data-msgid="large-row-42"]:visible').click();
    await expect.poll(() => threadRequests).toBe(1);
    await expect(page.locator('[data-testid="message-pane-toolbar"]:visible')).toBeVisible();
  });

});

test.describe('thread context and ThreadRow interaction regressions', () => {
  const physicalCardIds = async reader => reader.locator('article[data-physical-copy-id]').evaluateAll(cards => cards.map(card => card.dataset.physicalCopyId));

  test('keeps native reader membership identical for the same flat and grouped physical selection', async ({ page, fixtureApi }) => {
    await open(page, fixtureApi, false, true);
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    const flatReader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
    await expect(flatReader).toHaveAttribute('data-reader-source', 'native-thread');
    await expect(flatReader).toHaveAttribute('data-selected-account-id', 'account-gmail');
    const flatIds = await physicalCardIds(flatReader);
    expect(flatIds).toEqual([
      'conversation-gmail-copy-1', 'conversation-gmail-copy-2', 'conversation-gmail-copy-3',
      'conversation-gmail-copy-4', 'conversation-gmail-copy-5',
    ]);

    await open(page, fixtureApi, true, true);
    await page.locator('[data-msgid="conversation-gmail-copy-5"]:visible').locator('[data-thread-row-parent="true"]').click();
    await page.locator('[data-thread-row-child="conversation-gmail-copy-2"]:visible').click();
    const groupedReader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
    await expect(groupedReader).toHaveAttribute('data-reader-source', 'native-thread');
    await expect(groupedReader).toHaveAttribute('data-selected-account-id', 'account-gmail');
    await expect(groupedReader).toHaveAttribute('data-selected-copy-id', 'conversation-gmail-copy-2');
    expect(await physicalCardIds(groupedReader)).toEqual(flatIds);
    const groupedTarget = groupedReader.locator('#logical-message-conversation-gmail-logical-2');
    await expect(groupedTarget).toHaveAttribute('data-conversation-message-state', 'expanded');
    const targetPosition = await groupedTarget.evaluate(element => {
      const reader = element.closest('section');
      const anchor = element.querySelector('[data-conversation-message-scroll-anchor]');
      return anchor.getBoundingClientRect().top - reader.getBoundingClientRect().top;
    });
    expect(targetPosition).toBeGreaterThanOrEqual(0);
    expect(targetPosition).toBeLessThanOrEqual(120);
  });

  test('native membership excludes a stale CE card in flat and grouped reader modes', async ({ page, fixtureApi }, testInfo) => {
    test.skip(!isDesktopProject(testInfo), 'desktop parent-row selection contract');
    page.__ceMode = 'stale';
    await open(page, fixtureApi, false, true);
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    const flatReader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
    await expect(flatReader).toHaveAttribute('data-reader-source', 'native-thread');
    await expect(flatReader.locator('article')).toHaveCount(5);
    await expect(flatReader.locator('#logical-message-conversation-gmail-logical-stale')).toHaveCount(0);

    await open(page, fixtureApi, true, true);
    const parent = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
    await parent.locator('[data-thread-row-subject="true"]').click();
    const groupedReader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
    await expect(groupedReader).toHaveAttribute('data-reader-source', 'native-thread');
    await expect(groupedReader.locator('article')).toHaveCount(5);
    await expect(groupedReader.locator('#logical-message-conversation-gmail-logical-stale')).toHaveCount(0);
  });

  test('whole parent surface toggles children, opens newest, and excludes child/action clicks', async ({ page, fixtureApi }, testInfo) => {
    test.skip(!isDesktopProject(testInfo), 'desktop parent-row selection contract');
    await open(page, fixtureApi, true, true);
    const parent = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
    const parentSurface = parent.locator('[data-thread-row-parent="true"]');
    await parent.locator('[data-thread-row-subject="true"]').click();
    await expect(parentSurface).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-ce-selected-message-id="conversation-gmail-copy-5"]:visible')).toBeVisible();

    await parent.locator('[data-thread-row-child="conversation-gmail-copy-2"]').click();
    await expect(parentSurface).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-ce-selected-message-id="conversation-gmail-copy-2"]:visible')).toBeVisible();

    await parent.locator('[data-thread-row-star="true"]').click();
    await expect(parentSurface).toHaveAttribute('aria-expanded', 'true');

    await parent.locator('[data-thread-row-subject="true"]').click();
    await expect(parentSurface).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-ce-selected-message-id="conversation-gmail-copy-2"]:visible')).toBeVisible();

    await parentSurface.press('Enter');
    await expect(parentSurface).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-ce-selected-message-id="conversation-gmail-copy-5"]:visible')).toBeVisible();

    await parentSurface.press('Space');
    await expect(parentSurface).toHaveAttribute('aria-expanded', 'false');
  });
});

test.describe('reader target navigation follow-up', () => {
  test('marks only the opened target read, keeps unread siblings bold, and navigates to a newly selected child', async ({ page, fixtureApi }, testInfo) => {
    test.skip(!isDesktopProject(testInfo), 'desktop list remains visible for consecutive physical-copy selection');
    page.__unreadCopies = ['conversation-gmail-copy-3', 'conversation-gmail-copy-5'];
    await open(page, fixtureApi, false, true);
    await page.locator('[data-msgid="conversation-gmail-copy-5"]:visible').click();
    const reader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
    await expect.poll(() => page.__bulkReadActions || []).toEqual([{ ids: ['conversation-gmail-copy-5'], read: true }]);
    const m3 = reader.locator('#logical-message-conversation-gmail-logical-3 [data-conversation-message-subject="true"]');
    const m5 = reader.locator('#logical-message-conversation-gmail-logical-5 [data-conversation-message-subject="true"]');
    await expect(m3).toHaveAttribute('data-unread', 'true');
    await expect(m5).toHaveAttribute('data-unread', 'false');
    await expect(m3).toHaveCSS('font-weight', '700');
    await expect(m5).toHaveCSS('font-weight', '400');

    await page.locator('[data-msgid="conversation-gmail-copy-3"]:visible').click();
    await expect(reader).toHaveAttribute('data-selected-copy-id', 'conversation-gmail-copy-3');
    // Network retries can repeat an idempotent bulk-read request. The regression
    // boundary is the set of physical copies changed, not the transport attempt
    // count: opening copy 3 must never mark an unread sibling as read.
    await expect.poll(() => [...new Set((page.__bulkReadActions || [])
      .filter(action => action.read)
      .flatMap(action => action.ids))].sort()).toEqual([
      'conversation-gmail-copy-3',
      'conversation-gmail-copy-5',
    ]);
    await expect(m3).toHaveAttribute('data-unread', 'false');
  });

  test('aligns the selected message action toolbar at the reader visible top and never resnaps', async ({ page, fixtureApi }) => {
    await open(page, fixtureApi, false, true);
    await page.evaluate(() => {
      window.__readerScrollWrites = 0;
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
        configurable: true,
        get() { return descriptor.get.call(this); },
        set(value) { if (this.matches('section[data-conversation-id]')) window.__readerScrollWrites += 1; return descriptor.set.call(this, value); },
      });
      window.__readerRafCount = 0;
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => { window.__readerRafCount += 1; return raf(callback); };
    });
    await page.locator('[data-msgid="conversation-gmail-copy-4"]:visible').click();
    const reader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
    const target = reader.locator('[data-conversation-message-state="expanded"]');
    const toolbar = target.locator('[data-conversation-message-actions="true"]');
    const header = target.locator('[data-conversation-message-header]');
    await expect(toolbar).toBeVisible();
    await expect(header).toBeVisible();
    const readGeometry = () => target.evaluate(element => {
      const reader = element.closest('section');
      const anchor = element.querySelector('[data-conversation-message-scroll-anchor]');
      const actions = element.querySelector('[data-conversation-message-actions="true"]');
      const subject = element.querySelector('[data-conversation-message-header]');
      const readerRect = reader.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const toolbarRect = actions.getBoundingClientRect();
      const headerRect = subject.getBoundingClientRect();
      return {
        anchorError: anchorRect.top - (readerRect.top + 8),
        toolbarTop: toolbarRect.top, toolbarBottom: toolbarRect.bottom,
        headerTop: headerRect.top, readerTop: readerRect.top, readerBottom: readerRect.bottom,
      };
    });
    // Body layout schedules the reader's final alignment on animation frames. The
    // toolbar can be visible before that post-layout pass, so sampling immediately
    // creates a timing race rather than exercising the intended final geometry.
    await expect.poll(async () => Math.abs((await readGeometry()).anchorError)).toBeLessThanOrEqual(3);
    const geometry = await readGeometry();
    expect(Math.abs(geometry.anchorError)).toBeLessThanOrEqual(3);
    expect(geometry.toolbarTop).toBeGreaterThanOrEqual(geometry.readerTop);
    expect(geometry.toolbarBottom).toBeLessThanOrEqual(geometry.readerBottom);
    // DOMRect values are fractional; allow sub-pixel compositor rounding between
    // adjacent toolbar and header rects without masking a visible overlap.
    expect(geometry.headerTop).toBeGreaterThanOrEqual(geometry.toolbarBottom - 0.01);
    // The pure alignment helper verifies geometry/clamping. This browser contract
    // verifies that one navigation schedules exactly one scroll sequence.
    expect(await page.evaluate(() => window.__readerScrollWrites)).toBeLessThanOrEqual(2);
    // Simulate the user's independent scroll, then a body/iframe layout event and
    // a read-state update. Neither is a new physical navigation and neither may snap.
    await reader.evaluate(element => { element.scrollTop = Math.max(0, element.scrollTop - 80); });
    const userScrollTop = await reader.evaluate(element => element.scrollTop);
    await target.locator('iframe').evaluate(frame => frame.dispatchEvent(new Event('resize')));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('mailflow:read-state', {
      detail: { id: 'conversation-gmail-copy-4', read: true },
    })));
    await expect.poll(() => reader.evaluate(element => element.scrollTop)).toBe(userScrollTop);
    expect(await page.evaluate(() => window.__readerScrollWrites)).toBeLessThanOrEqual(3); // up to two alignments + user scroll
  });

  test('uses final target body geometry: short last message bottoms out, long last and middle messages align their headers', async ({ page, fixtureApi }, testInfo) => {
    test.skip(testInfo.project.name === 'chromium-mobile-landscape', 'landscape viewport uses the desktop layout contract');
    const select = async (copy, mode, index) => {
      page.__conversationSize = 10;
      page.__targetBodyMode = mode;
      page.__targetBodyCopy = String(index);
      await open(page, fixtureApi, false, true);
      await page.locator(`[data-msgid="${copy}"]:visible`).click();
      const reader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
      const target = reader.locator(`#logical-message-conversation-gmail-logical-${index}`);
      const anchor = target.locator('[data-conversation-message-scroll-anchor]');
      const header = target.locator('[data-conversation-message-header]');
      await expect(anchor).toBeVisible();
      await expect(target.locator('iframe')).toBeVisible();
      await expect.poll(() => reader.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
      return { reader, target, anchor, header };
    };
    const short = await select('conversation-gmail-copy-10', 'short', 10);
    await expect(short.target.locator('iframe').contentFrame().locator('[data-testid="target-body"]')).toBeVisible();
    // The initial iframe paint and the parent's final scroll-range commit are
    // separate layout passes. Wait for the settled terminal geometry instead of
    // sampling the transient placeholder range.
    await expect.poll(() => short.reader.evaluate(element => Math.abs(
      element.scrollTop - (element.scrollHeight - element.clientHeight),
    ))).toBeLessThanOrEqual(1);

    const long = await select('conversation-gmail-copy-10', 'long', 10);
    await expect(long.target.locator('iframe').contentFrame().locator('[data-testid="target-body"]')).toBeVisible();
    await expect.poll(() => long.anchor.evaluate(element => {
      const reader = element.closest('section');
      return element.getBoundingClientRect().top - reader.getBoundingClientRect().top;
    })).toBeLessThanOrEqual(12);

    const twoPhaseNavigation = async ({ target, start }) => {
      page.__conversationSize = 10;
      page.__targetBodyMode = 'long';
      page.__targetBodyCopy = String(target);
      await open(page, fixtureApi, false, true);
      await page.locator('[data-msgid="conversation-gmail-copy-10"]:visible').click();
      const reader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
      await expect(reader.locator('#logical-message-conversation-gmail-logical-10 iframe')).toBeVisible();
      await reader.evaluate((element, position) => { element.scrollTop = position === 'bottom'
        ? element.scrollHeight - element.clientHeight : 0; }, start);
      const previousScrollTop = await reader.evaluate(element => element.scrollTop);
      await page.evaluate(() => {
        window.__twoPhaseReaderWrites = [];
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
        Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
          configurable: true,
          get() { return descriptor.get.call(this); },
          set(value) {
            if (this.matches('section[data-conversation-id]')) window.__twoPhaseReaderWrites.push(value);
            return descriptor.set.call(this, value);
          },
        });
      });
      // Programmatic click deliberately preserves the requested starting viewport:
      // Playwright's visibility auto-scroll would hide the reader's own preliminary
      // navigation phase. The real header handler expands, mounts a 300px iframe,
      // then reports its larger first measured body layout.
      await reader.locator(`#logical-message-conversation-gmail-logical-${target} [data-conversation-message-header]`).evaluate(element => element.click());
      const anchor = reader.locator(`#logical-message-conversation-gmail-logical-${target} [data-conversation-message-scroll-anchor]`);
      await expect(anchor).toBeVisible();
      await expect(reader.locator(`#logical-message-conversation-gmail-logical-${target} iframe`).contentFrame().locator('[data-testid="target-body"]')).toBeVisible();
      await expect.poll(async () => anchor.evaluate(element => {
        const container = element.closest('section');
        return Math.abs(element.getBoundingClientRect().top - (container.getBoundingClientRect().top + 8));
      })).toBeLessThanOrEqual(2);
      const geometry = await anchor.evaluate(element => {
        const container = element.closest('section');
        return {
          scrollTop: container.scrollTop,
          maxScrollTop: container.scrollHeight - container.clientHeight,
          error: element.getBoundingClientRect().top - (container.getBoundingClientRect().top + 8),
        };
      });
      const writes = await page.evaluate(() => window.__twoPhaseReaderWrites);
      // The first write is preliminary against the placeholder; the second is the
      // post-body-layout live-rect correction. The preliminary phase must really
      // scroll from the non-zero/opposite starting location.
      expect(writes).toHaveLength(2);
      expect(writes[0]).not.toBe(previousScrollTop);
      return { previousScrollTop, geometry, writes };
    };

    // A: reader starts around M8, then M3 is selected above it.
    const early = await twoPhaseNavigation({ target: 3, start: 'bottom' });
    expect(early.geometry.scrollTop).toBeLessThan(early.geometry.maxScrollTop);
    // B/C: body layout can settle concurrently with the initial selection, so raw
    // scroll direction is not a stable contract. The helper verifies final anchor
    // geometry and both alignment phases; middle targets must not bottom-clamp.
    const later = await twoPhaseNavigation({ target: 7, start: 'top' });
    expect(later.geometry.scrollTop).toBeLessThan(later.geometry.maxScrollTop);
    const middle = await twoPhaseNavigation({ target: 4, start: 'top' });
    expect(middle.geometry.scrollTop).toBeLessThan(middle.geometry.maxScrollTop);
    const middleToolbarGeometry = await page.locator('#logical-message-conversation-gmail-logical-4').evaluate(element => {
      const reader = element.closest('section');
      const toolbar = element.querySelector('[data-conversation-message-actions="true"]')?.getBoundingClientRect();
      const header = element.querySelector('[data-conversation-message-header]')?.getBoundingClientRect();
      const viewport = reader.getBoundingClientRect();
      return { toolbarTop: toolbar?.top, toolbarBottom: toolbar?.bottom, headerTop: header?.top, viewportTop: viewport.top, viewportBottom: viewport.bottom };
    });
    expect(middleToolbarGeometry.toolbarTop).toBeGreaterThanOrEqual(middleToolbarGeometry.viewportTop);
    expect(middleToolbarGeometry.toolbarBottom).toBeLessThanOrEqual(middleToolbarGeometry.viewportBottom);
    expect(middleToolbarGeometry.headerTop).toBeGreaterThanOrEqual(middleToolbarGeometry.toolbarBottom);
  });

});

test.describe('mobile parent thread navigation follow-up', () => {
  test('keeps parent taps list-only while an exact child opens the configured native reader', async ({ page, fixtureApi }, testInfo) => {
    test.skip(!isPortraitMobileProject(testInfo), 'portrait touch viewport contract');
    page.__unreadCopies = ['conversation-gmail-copy-3', 'conversation-gmail-copy-5'];
    await open(page, fixtureApi, true, true);
    const parent = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
    const parentSurface = parent.locator('[data-thread-row-parent="true"]');
    await parentSurface.click();
    await expect(parentSurface).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('section[data-conversation-id]:visible')).toHaveCount(0);
    await expect.poll(() => page.__bulkReadActions || []).toEqual([]);
    await parentSurface.click();
    await expect(parentSurface).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('section[data-conversation-id]:visible')).toHaveCount(0);
    await expect.poll(() => page.__bulkReadActions || []).toEqual([]);
    await parentSurface.click();
    await expect(parentSurface).toHaveAttribute('aria-expanded', 'true');
    await parent.locator('[data-thread-row-child="conversation-gmail-copy-3"]').click();
    const reader = page.locator('section[data-conversation-id="conversation-gmail"]:visible');
    await expect(reader).toHaveAttribute('data-reader-source', 'native-thread');
    await expect(reader).toHaveAttribute('data-selected-copy-id', 'conversation-gmail-copy-3');
    await expect(reader.locator('article')).toHaveCount(5);
    await expect(reader.locator('#logical-message-conversation-gmail-logical-3')).toHaveAttribute('data-conversation-message-state', 'expanded');
    await expect.poll(() => page.__bulkReadActions || []).toEqual([{ ids: ['conversation-gmail-copy-3'], read: true }]);
  });

  test('uses the real touch stream on parent and child rows without turning a swipe into a click', async ({ page, fixtureApi }, testInfo) => {
    test.skip(!isPortraitMobileProject(testInfo), 'portrait touch viewport contract');
    await open(page, fixtureApi, true, false);
    const parent = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
    const gesture = async locator => {
      const rect = await locator.boundingBox();
      expect(rect).not.toBeNull();
      const client = await page.context().newCDPSession(page);
      const x = rect.x + Math.min(220, rect.width - 20);
      const y = rect.y + Math.min(20, rect.height / 2);
      // Use Chromium's input domain rather than dispatching synthetic TouchEvents:
      // synthetic DOM events do not model browser gesture suppression correctly.
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y }] });
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: x - 40, y }] });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await client.detach();
    };
    await gesture(parent.locator('[data-thread-row-parent="true"]'));
    await expect(parent.locator('[data-thread-row-child]')).toHaveCount(0);
    await expect.poll(() => page.__bulkReadActions || []).toEqual([]);

    // useSwipeRow deliberately suppresses the synthetic click after a touch stream.
    // Let that guard expire before verifying the following independent user tap.
    await page.waitForTimeout(350);
    await parent.click();
    await expect(parent.locator('[data-thread-row-child]')).toHaveCount(5);
    page.__bulkReadActions = [];
    await gesture(parent.locator('[data-thread-row-parent="true"]'));
    await expect(parent.locator('[data-thread-row-child]')).toHaveCount(5);
    await expect.poll(() => page.__bulkReadActions || []).toEqual([]);

    page.__bulkReadActions = [];
    await gesture(parent.locator('[data-thread-row-child="conversation-gmail-copy-3"]'));
    await expect.poll(() => page.__bulkReadActions || []).toEqual([]);
  });
});
