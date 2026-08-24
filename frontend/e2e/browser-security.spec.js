import { test, expect } from './fixtures.js';

const hostileHtml = `
  <p>Security fixture body</p>
  <img src="https://tracker.example.test/pixel.gif">
  <img src="http://evil.example.test/http.gif">
  <img src="//evil.example.test/protocol.gif">
  <img srcset="https://tracker.example.test/a.gif 1x, https://evil.example.test/b.gif 2x">
  <div style="background-image:url('https://evil.example.test/css.gif')">css</div>
  <a href="javascript:alert(1)">bad javascript</a>
  <a href="data:text/html,evil">bad data</a>
  <img src="cid:local-image-1">
  <a href="https://safe.example.test/help">Safe HTTPS link</a>
`;

async function openFixtureConversation(page) {
  await page.route('**/api/mail/conversations/*/logical-messages/*/body**', route => {
    const wantsRemote = new URL(route.request().url()).searchParams.get('remoteImages') === '1';
    const allowedBody = hostileHtml
      .replace('https://evil.example.test/http.gif', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==')
      .replace('//evil.example.test/protocol.gif', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==')
      .replace('https://evil.example.test/b.gif', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==')
      .replace("url('https://evil.example.test/css.gif')", 'none');
    return route.fulfill({
      json: { body_text: 'Security fixture body', body_html: wantsRemote ? allowedBody : hostileHtml },
    });
  });
  await page.goto('/?list=1&reader=1');
  const list = page.locator('[role="list"]:visible').first();
  await expect(list.getByRole('button', { name: /Rozwiń rozmowę: Gmail reply chain|Expand conversation: Gmail reply chain/i })).toBeVisible();
  await list.getByRole('button', { name: /Rozwiń rozmowę: Gmail reply chain|Expand conversation: Gmail reply chain/i }).click();
  await list.locator('[data-logical-message-id]').first().click();
  const pane = page.locator('section[data-conversation-id]:visible').first();
  await expect(pane).toBeVisible();
  await expect(pane.locator('iframe').first()).toBeVisible();
  return pane;
}

test.describe('MessageBodyRenderer browser network security', () => {
  test('remote images OFF cause zero external tracker requests and preserve safe HTTPS link/CID', async ({ page, fixtureApi }) => {
    await fixtureApi;
    const externalRequests = [];
    page.on('request', request => {
      const url = request.url();
      if (/tracker\.example|evil\.example/.test(url)) externalRequests.push(url);
    });
    const pane = await openFixtureConversation(page);
    const frame = pane.locator('iframe').first().contentFrame();
    await expect(frame.getByText('Security fixture body')).toBeVisible();
    await expect(frame.getByRole('link', { name: 'Safe HTTPS link' })).toHaveAttribute('href', 'https://safe.example.test/help');
    await expect(frame.locator('[src^="cid:"]')).toHaveCount(1);
    await page.waitForTimeout(700);
    expect(externalRequests).toEqual([]);
  });

  test('Load images opts in to explicitly permitted HTTPS image resources only', async ({ page, fixtureApi }) => {
    await fixtureApi;
    const requests = [];
    await page.route('https://tracker.example.test/**', route => {
      requests.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64') });
    });
    await page.route('https://evil.example.test/**', route => {
      requests.push(route.request().url());
      return route.abort();
    });
    const pane = await openFixtureConversation(page);
    await pane.getByRole('button', { name: /Load images|Wczytaj obrazy/i }).first().click();
    await page.waitForTimeout(700);
    expect(requests.some(url => url.includes('tracker.example.test'))).toBe(true);
    expect(requests.some(url => url.includes('evil.example.test'))).toBe(false);
  });
});
