import { test, expect } from './fixtures.js';

const DESKTOP = 'chromium-desktop';
const MOBILE = new Set(['chromium-mobile-390', 'chromium-mobile']);

async function openList(page, fixtureApi, testInfo, unread = ['conversation-gmail-copy-1'], starred = [], mixedReadState = false, grouped = false) {
  page.__conversationMatrix = '11';
  page.__unreadCopies = unread;
  page.__starredCopies = new Set(starred);
  page.__mixedReadState = mixedReadState;
  await fixtureApi;
  await page.goto(`/?list=${Number(grouped)}&reader=1`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-msgid="conversation-gmail-copy-5"]:visible')).toBeVisible();
}

function holdThreadResolution(page) {
  let release;
  page.__threadLoadMessages = Array.from({ length: 5 }, (_, index) => ({
    id: `conversation-gmail-copy-${index + 1}`,
    account_id: 'account-gmail',
    folder: [2, 4].includes(index + 1) ? 'Sent' : 'INBOX',
    is_read: !page.__unreadCopies.includes(`conversation-gmail-copy-${index + 1}`),
    is_starred: false,
    thread_id: 'conversation-gmail',
    thread_key: 'conversation-gmail',
    date: new Date(2026, 0, index + 1).toISOString(),
  }));
  page.__threadLoadGate = { promise: new Promise(resolve => { release = resolve; }) };
  return () => {
    page.__threadLoadGate = null;
    release();
  };
}

function holdThreadResolutions(page, count = 2) {
  const gates = Array.from({ length: count }, () => {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
  });
  page.__threadLoadGates = gates;
  return gates.map(gate => () => {
    page.__threadLoadGates = page.__threadLoadGates.filter(candidate => candidate !== gate);
    gate.release();
  });
}

function holdConversationAction(page, action) {
  let release;
  page.__conversationActionGates = page.__conversationActionGates || {};
  page.__conversationActionGates[action] = {
    promise: new Promise(resolve => { release = resolve; }),
  };
  return () => {
    if (Array.isArray(page.__conversationActionGates[action])) page.__conversationActionGates[action].shift();
    else delete page.__conversationActionGates[action];
    release();
  };
}

function holdAction(page, property, key) {
  let release;
  const gate = { promise: new Promise(resolve => { release = resolve; }) };
  page[property] = page[property] || {};
  page[property][key] = page[property][key] || [];
  page[property][key].push(gate);
  return () => {
    page[property][key] = page[property][key].filter(candidate => candidate !== gate);
    release();
  };
}

async function openContextMenu(page, row, testInfo) {
  if (testInfo.project.name === DESKTOP) {
    await row.click({ button: 'right' });
  } else {
    await row.locator('button').last().click();
  }
  await expect(page.getByText(/oznacz jako|mark as|move to|przenieś|archiwizuj|archive|usuń|delete/i).last()).toBeVisible();
}

async function chooseMenuItem(page, pattern) {
  await page.getByText(pattern).last().click();
}

async function waitForConversationAction(page, action) {
  await expect.poll(
    () => page.__conversationActions.some(candidate => candidate.action === action),
    { timeout: 10_000 },
  ).toBe(true);
}


async function clickRowAction(page, row, testInfo, buttonPattern, menuPattern = buttonPattern) {
  if (testInfo.project.name === DESKTOP) {
    await row.hover();
    await row.getByRole('button', { name: buttonPattern }).click();
  } else {
    await openContextMenu(page, row, testInfo);
    await chooseMenuItem(page, menuPattern);
  }
}

async function swipe(row, fromX, toX) {
  await row.evaluate((container, [startX, endX]) => {
    const element = container.querySelector('[role="button"]') || container;
    const touch = clientX => new Touch({ identifier: 1, target: element, clientX, clientY: 120 });
    element.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(startX)] }));
    element.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [touch(endX)] }));
    element.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
  }, [fromX, toX]);
}

for (const viewport of [DESKTOP, 'mobile']) {
  test.describe(`thread mutations (${viewport})`, () => {
    test.beforeEach(async ({ page }, testInfo) => {
      if (viewport === DESKTOP) test.skip(testInfo.project.name !== DESKTOP, 'desktop mutation contract');
      else test.skip(!MOBILE.has(testInfo.project.name), 'portrait mobile mutation contract');
    });

    test('runs the production touch callback for configured read and star swipes', async ({ page, fixtureApi }, testInfo) => {
      test.skip(!MOBILE.has(testInfo.project.name), 'touch callback contract');
      await openList(page, fixtureApi, testInfo, ['conversation-gmail-copy-5'], [], false, true);
      const row = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
      page.__bulkReadActions = [];
      await swipe(row, 120, 230);
      await expect.poll(() => page.__bulkReadActions.at(-1)).toEqual({ ids: ['conversation-gmail-copy-5'], read: true });

      await page.addInitScript(() => localStorage.setItem('mailflow_swipe_actions', JSON.stringify({ left: 'archive', right: 'star' })));
      await page.reload({ waitUntil: 'domcontentloaded' });
      const starredRow = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
      page.__starActions = [];
      await swipe(starredRow, 120, 230);
      await expect.poll(() => page.__starActions.length).toBeGreaterThan(0);
      await expect.poll(() => page.__starActions.at(-1).body.starred).toBe(false);
      await expect(starredRow.locator('[data-thread-row-star="true"]')).toHaveCount(0);
    });

    test('read and star update immediately, roll back failures, and keep the newest read intent', async ({ page, fixtureApi }, testInfo) => {
      await openList(page, fixtureApi, testInfo, [
        'conversation-gmail-copy-1', 'conversation-gmail-copy-3', 'conversation-gmail-copy-5',
      ]);
      page.__bulkReadActions = [];
      page.__bulkReadStarts = [];
      page.__starStarts = [];
      const row = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
      const sender = row.locator('span').filter({ hasText: 'sender@gmail.test' }).first();

      await row.hover();
      const releaseRead = holdThreadResolution(page);
      await openContextMenu(page, row, testInfo);
      await chooseMenuItem(page, /oznacz jako przeczytan|mark as read/i);
      await expect.poll(() => sender.evaluate(element => getComputedStyle(element).fontWeight)).toBe('400');
      await expect.poll(() => page.__threadLoadStarts.length).toBe(1);
      releaseRead();
      await expect.poll(() => page.__bulkReadStarts.length).toBe(5);
      await expect.poll(() => page.__bulkReadActions.length).toBe(5);
      expect(page.__bulkReadActions.map(action => action.ids)).toEqual([
        ['conversation-gmail-copy-1'], ['conversation-gmail-copy-2'], ['conversation-gmail-copy-3'],
        ['conversation-gmail-copy-4'], ['conversation-gmail-copy-5'],
      ]);
      await openContextMenu(page, row, testInfo);
      await chooseMenuItem(page, /oznacz jako nieprzeczytan|mark as unread/i);
      await expect.poll(() => sender.evaluate(element => getComputedStyle(element).fontWeight)).toBe('600');
      await expect.poll(() => page.__bulkReadActions.length).toBe(10);
      await expect.poll(() => page.__bulkReadActions.at(-1)?.read).toBe(false);
      await expect.poll(() => sender.evaluate(element => getComputedStyle(element).fontWeight)).toBe('600');

      page.__bulkReadFailureIds = new Set(['conversation-gmail-copy-3']);
      await openContextMenu(page, row, testInfo);
      await chooseMenuItem(page, /oznacz jako przeczytan|mark as read/i);
      await expect.poll(() => page.__bulkReadActions.length).toBe(15);
      await expect.poll(() => sender.evaluate(element => getComputedStyle(element).fontWeight)).toBe('600');

      page.__starFailureIds = new Set(['conversation-gmail-copy-3']);
      page.__starActions = [];
      const releaseStar = holdAction(page, '__starGates', 'true');
      await openContextMenu(page, row, testInfo);
      await chooseMenuItem(page, /gwiazd|star/i);
      await expect.poll(() => page.__starStarts.length).toBe(5);
      releaseStar();
      await expect.poll(() => page.__starActions.length).toBe(5);
      await expect(row.locator('[data-thread-row-star="true"]')).toHaveCount(0);
      expect(page.__starActions.filter(action => action.id === 'conversation-gmail-copy-3')).toHaveLength(1);
    });

    test('overlapping read and star on a collapsed thread dispatch both action lanes', async ({ page, fixtureApi }, testInfo) => {
      await openList(page, fixtureApi, testInfo, ['conversation-gmail-copy-5']);
      page.__bulkReadStarts = [];
      page.__starStarts = [];
      page.__threadLoadStarts = [];
      const row = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
      const sender = row.locator('span').filter({ hasText: 'sender@gmail.test' }).first();
      const releaseThread = holdThreadResolution(page);

      await openContextMenu(page, row, testInfo);
      await chooseMenuItem(page, /oznacz jako przeczytan|mark as read/i);
      await expect.poll(() => page.__threadLoadStarts.length).toBe(1);
      await openContextMenu(page, row, testInfo);
      await chooseMenuItem(page, /gwiazd|star/i);
      await expect.poll(() => page.__threadLoadStarts.length).toBe(2);

      releaseThread();
      await expect.poll(() => page.__bulkReadStarts.length).toBe(5);
      await expect.poll(() => page.__starStarts.length).toBe(5);
      expect(page.__starStarts.every(action => action.body?.starred === false)).toBe(true);
      await expect(row.locator('[data-thread-row-star="true"]')).toHaveCount(0);
      await expect(sender).toHaveCSS('font-weight', '400');
    });

    test('overlapping star and read on a collapsed thread dispatch both action lanes', async ({ page, fixtureApi }, testInfo) => {
      await openList(page, fixtureApi, testInfo, ['conversation-gmail-copy-5']);
      page.__bulkReadStarts = [];
      page.__starStarts = [];
      page.__threadLoadStarts = [];
      const row = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
      const sender = row.locator('span').filter({ hasText: 'sender@gmail.test' }).first();
      const releaseThread = holdThreadResolution(page);

      await openContextMenu(page, row, testInfo);
      await chooseMenuItem(page, /gwiazd|star/i);
      await expect.poll(() => page.__threadLoadStarts.length).toBe(1);
      await openContextMenu(page, row, testInfo);
      await chooseMenuItem(page, /oznacz jako przeczytan|mark as read/i);
      await expect.poll(() => page.__threadLoadStarts.length).toBe(2);

      releaseThread();
      await expect.poll(() => page.__bulkReadStarts.length).toBe(5);
      await expect.poll(() => page.__starStarts.length).toBe(5);
      expect(page.__starStarts.every(action => action.body?.starred === false)).toBe(true);
      await expect(row.locator('[data-thread-row-star="true"]')).toHaveCount(0);
      await expect(sender).toHaveCSS('font-weight', '400');
    });

    test('reversed cold star resolutions preserve star then unstar newest intent', async ({ page, fixtureApi }, testInfo) => {
      page.__initialThreadStarred = false;
      await openList(page, fixtureApi, testInfo, [], [], false, true);
      const row = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
      page.__starStarts = [];
      page.__starActions = [];
      const release = holdThreadResolutions(page);
      await openContextMenu(page, row, testInfo);
      await chooseMenuItem(page, /gwiazd|star/i);
      await expect(row.locator('[data-thread-row-star="true"]')).toBeVisible();
      await openContextMenu(page, row, testInfo);
      await chooseMenuItem(page, /gwiazd|star/i);
      await expect(row.locator('[data-thread-row-star="true"]')).toHaveCount(0);
      await expect.poll(() => page.__threadLoadStarts.length).toBe(2);
      release[1]();
      await expect.poll(() => page.__starStarts.length).toBe(5);
      release[0]();
      await expect.poll(() => page.__starActions.length).toBe(5);
      expect(page.__starActions.map(action => action.body.starred)).toEqual([false, false, false, false, false]);
      await expect(row.locator('[data-thread-row-star="true"]')).toHaveCount(0);
    });

    test('reversed cold star resolutions preserve unstar then star newest intent', async ({ page, fixtureApi }, testInfo) => {
      await openList(page, fixtureApi, testInfo, [], [], false, true);
      const row = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
      page.__starStarts = [];
      page.__starActions = [];
      const release = holdThreadResolutions(page);
      await openContextMenu(page, row, testInfo);
      await chooseMenuItem(page, /gwiazd|star/i);
      await expect(row.locator('[data-thread-row-star="true"]')).toHaveCount(0);
      await openContextMenu(page, row, testInfo);
      await chooseMenuItem(page, /gwiazd|star/i);
      await expect(row.locator('[data-thread-row-star="true"]')).toBeVisible();
      await expect.poll(() => page.__threadLoadStarts.length).toBe(2);
      release[1]();
      await expect.poll(() => page.__starStarts.length).toBe(5);
      expect(page.__starStarts.every(action => action.body.starred === true)).toBe(true);
      release[0]();
      await expect.poll(() => page.__starActions.length).toBe(5);
      expect(page.__starActions.every(action => action.body.starred === true)).toBe(true);
      await expect(row.locator('[data-thread-row-star="true"]')).toBeVisible();
    });

    test('stale cold star resolution failure leaves the newest intent visible', async ({ page, fixtureApi }, testInfo) => {
      page.__initialThreadStarred = false;
      page.__nativeThreadLoadFailuresRemaining = 1;
      await openList(page, fixtureApi, testInfo, [], [], false, true);
      const row = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
      page.__starStarts = [];
      const release = holdThreadResolutions(page);
      await openContextMenu(page, row, testInfo);
      await chooseMenuItem(page, /gwiazd|star/i);
      await openContextMenu(page, row, testInfo);
      await chooseMenuItem(page, /gwiazd|star/i);
      await expect(row.locator('[data-thread-row-star="true"]')).toHaveCount(0);
      release[0]();
      release[1]();
      await expect.poll(() => page.__starStarts.length).toBe(5);
      expect(page.__starStarts.every(action => action.body.starred === false)).toBe(true);
      await expect(row.locator('[data-thread-row-star="true"]')).toHaveCount(0);
    });

    test('failed no-op copies do not drift read counters', async ({ page, fixtureApi }, testInfo) => {
      await openList(page, fixtureApi, testInfo, ['conversation-gmail-copy-1', 'conversation-gmail-copy-5'], [], true);
      const row = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
      const sender = row.locator('span').filter({ hasText: 'sender@gmail.test' }).first();
      const account = page.getByText('e2e@example.test').first().locator('..').locator('..').locator('..');

      page.__bulkReadActions = [];
      page.__bulkReadFailureIds = new Set(['conversation-gmail-copy-2']);
      await openContextMenu(page, row, testInfo);
      await chooseMenuItem(page, /oznacz jako przeczytan|mark as read/i);
      await expect.poll(() => page.__bulkReadActions.length).toBe(5);
      await expect(sender).toHaveCSS('font-weight', '400');
      await expect(row.locator('.unread-dot')).toHaveCount(0);
      await expect(account).not.toContainText('1');
    });

    test('failed no-op unread copy does not roll back counters', async ({ page, fixtureApi }, testInfo) => {
      await openList(page, fixtureApi, testInfo, ['conversation-gmail-copy-2'], [], true);
      const row = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
      const sender = row.locator('span').filter({ hasText: 'sender@gmail.test' }).first();
      const account = page.getByText('e2e@example.test').first().locator('..').locator('..').locator('..');
      page.__bulkReadActions = [];
      page.__bulkReadFailureIds = new Set(['conversation-gmail-copy-2']);
      await openContextMenu(page, row, testInfo);
      await chooseMenuItem(page, /oznacz jako nieprzeczytan|mark as unread/i);
      await expect.poll(() => page.__bulkReadActions.length).toBe(5);
      await expect(sender).toHaveCSS('font-weight', '600');
      await expect(row.locator('.unread-dot')).toHaveCount(1);
      if (!MOBILE.has(testInfo.project.name)) await expect(account).toContainText('5');
    });

    test('archive, move, and delete remove immediately and restore their own row on API failure', async ({ page, fixtureApi }, testInfo) => {
      test.setTimeout(60_000);
      await openList(page, fixtureApi, testInfo);
      const row = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
      page.__conversationActionFailures = new Set(['archive']);
      const releaseArchiveApi = holdConversationAction(page, 'archive');
      const releaseArchive = holdThreadResolution(page);
      await openContextMenu(page, row, testInfo);
      await chooseMenuItem(page, /archiwizuj|archive/i);
      await expect(row).toHaveCount(0);
      releaseArchive();
      await waitForConversationAction(page, 'archive');
      await expect(row).toHaveCount(0);
      releaseArchiveApi();
      await expect(row).toBeVisible();

      await page.reload({ waitUntil: 'domcontentloaded' });
      const moved = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
      await expect(moved).toBeVisible();
      page.__conversationActionFailures = new Set(['move']);
      const releaseMoveApi = holdConversationAction(page, 'move');
      const releaseMoveThread = holdThreadResolution(page);
      if (testInfo.project.name === DESKTOP) {
        await moved.hover();
        await moved.locator('button[aria-label*="Przenieś"], button[aria-label*="Move"]').first().click();
      } else {
        await openContextMenu(page, moved, testInfo);
        await chooseMenuItem(page, /przenieś|move/i);
      }
      await chooseMenuItem(page, /archive|archiwum/i);
      await expect(moved).toHaveCount(0);
      releaseMoveThread();
      await waitForConversationAction(page, 'move');
      await expect(moved).toHaveCount(0);
      releaseMoveApi();
      await expect(moved).toBeVisible();

      await page.reload({ waitUntil: 'domcontentloaded' });
      const deleted = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
      await expect(deleted).toBeVisible();
      page.__conversationActionFailures = new Set(['delete']);
      const releaseDeleteApi = holdConversationAction(page, 'delete');
      const releaseDeleteThread = holdThreadResolution(page);
      await openContextMenu(page, deleted, testInfo);
      await chooseMenuItem(page, /usuń|delete/i);
      await expect(deleted).toHaveCount(0);
      releaseDeleteThread();
      await waitForConversationAction(page, 'delete');
      await expect(deleted).toHaveCount(0);
      releaseDeleteApi();
      await expect(deleted).toBeVisible();
    });

    test('archive, move, and delete send successful aggregate requests', async ({ page, fixtureApi }, testInfo) => {
      test.setTimeout(60_000);
      await openList(page, fixtureApi, testInfo);
      const expectedCopies = [
        'conversation-gmail-copy-1', 'conversation-gmail-copy-3', 'conversation-gmail-copy-5',
      ];
      const archiveRow = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
      await openContextMenu(page, archiveRow, testInfo);
      await chooseMenuItem(page, /archiwizuj|archive/i);
      await expect(archiveRow).toHaveCount(0);
      await waitForConversationAction(page, 'archive');
      const archive = page.__conversationActions.find(action => action.action === 'archive');
      expect(archive?.body?.ids).toEqual(expect.arrayContaining(expectedCopies));

      await page.reload({ waitUntil: 'domcontentloaded' });
      const moveRow = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
      await expect(moveRow).toBeVisible();
      if (testInfo.project.name === DESKTOP) {
        await moveRow.hover();
        await moveRow.locator('button[aria-label*="Przenieś"], button[aria-label*="Move"]').first().click();
      } else {
        await openContextMenu(page, moveRow, testInfo);
        await chooseMenuItem(page, /przenieś|move/i);
      }
      await chooseMenuItem(page, /archive|archiwum/i);
      await expect(moveRow).toHaveCount(0);
      await waitForConversationAction(page, 'move');
      const move = page.__conversationActions.find(action => action.action === 'move');
      expect(move?.body?.ids).toEqual(expect.arrayContaining(expectedCopies));

      await page.reload({ waitUntil: 'domcontentloaded' });
      const deleteRow = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
      await expect(deleteRow).toBeVisible();
      await openContextMenu(page, deleteRow, testInfo);
      await chooseMenuItem(page, /usuń|delete/i);
      await expect(deleteRow).toHaveCount(0);
      await waitForConversationAction(page, 'delete');
      const del = page.__conversationActions.find(action => action.action === 'delete');
      expect(del?.body?.ids).toEqual(expect.arrayContaining(expectedCopies));
    });

    test('undo invalidates delete and move after their deferred resolver starts', async ({ page, fixtureApi }, testInfo) => {
      test.setTimeout(30_000);
      await openList(page, fixtureApi, testInfo);
      const row = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
      page.__threadLoadStarts = [];
      const releaseDeleteThread = holdThreadResolution(page);
      await openContextMenu(page, row, testInfo);
      await chooseMenuItem(page, /usuń|delete/i);
      await expect(row).toHaveCount(0);
      await expect.poll(() => page.__threadLoadStarts.length).toBe(1);
      await page.getByRole('button', { name: /undo|cofnij/i }).last().click();
      releaseDeleteThread();
      await expect(row).toBeVisible();
      expect(page.__conversationActions.filter(action => action.action === 'delete')).toEqual([]);

      await page.reload({ waitUntil: 'domcontentloaded' });
      const moved = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
      await expect(moved).toBeVisible();
      page.__threadLoadStarts = [];
      const releaseMoveThread = holdThreadResolution(page);
      if (testInfo.project.name === DESKTOP) {
        await moved.hover();
        await moved.locator('button[aria-label*="Przenieś"], button[aria-label*="Move"]').first().click();
      } else {
        await openContextMenu(page, moved, testInfo);
        await chooseMenuItem(page, /przenieś|move/i);
      }
      await chooseMenuItem(page, /archive|archiwum/i);
      await expect(moved).toHaveCount(0);
      await expect.poll(() => page.__threadLoadStarts.length).toBe(1);
      await page.getByRole('button', { name: /undo|cofnij/i }).last().click();
      releaseMoveThread();
      await expect(moved).toBeVisible();
      expect(page.__conversationActions.filter(action => action.action === 'move')).toEqual([]);
    });

    test('undo invalidates archive after its deferred resolver starts', async ({ page, fixtureApi }, testInfo) => {
      test.setTimeout(30_000);
      await page.clock.install();
      await openList(page, fixtureApi, testInfo, [
        'conversation-gmail-copy-1', 'conversation-gmail-copy-3', 'conversation-gmail-copy-5',
      ]);
      const row = page.locator('[data-msgid="conversation-gmail-copy-5"]:visible');
      const account = page.getByText('Gmail fixture', { exact: true }).locator('../../..');
      page.__threadLoadStarts = [];
      page.__conversationActions = [];
      const releaseThread = holdThreadResolution(page);

      await openContextMenu(page, row, testInfo);
      await chooseMenuItem(page, /archiwizuj|archive/i);
      await expect(row).toHaveCount(0);
      await expect(account).not.toContainText('3');
      await page.clock.runFor(4751);
      await expect.poll(() => page.__threadLoadStarts.length).toBe(1);

      await page.getByRole('button', { name: /undo|cofnij/i }).last().click({ force: true });
      releaseThread();
      await expect(row).toBeVisible();
      await expect(account).toContainText('3');
      await expect.poll(() => page.__conversationActions.filter(action => action.action === 'archive')).toEqual([]);
    });
  });
}
