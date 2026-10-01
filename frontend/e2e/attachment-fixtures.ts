import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Page, Route, BrowserContext } from '@playwright/test';
import { expect } from './fixtures.ts';

export const fileBytes = (name: string) => readFileSync(new URL(`../../backend/fixtures/attachments/${name}`, import.meta.url));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sessions = new Map<string, Awaited<ReturnType<BrowserContext['cookies']>>>();
const officeFiles = ['example_password.docx', 'example_password.xlsx', 'plain.xls', 'workbook.xls'];
const byDigest = new Map(officeFiles.map(name => [digest(fileBytes(name)), name]));

/** Browser matrix has deterministic server responses. The real-app workflow also
 * runs these cases against the authenticated production processor and real workers. */
async function processing(route: Route) {
  if (process.env.ATTACHMENT_LIVE_PROCESSING === '1') return route.continue();
  const action = new URL(route.request().url()).pathname.split('/').at(-1);
  if (action === 'scan') return route.fulfill({ json: { scan: 'disabled' } });
  if (action === 'signatures') return route.fulfill({ json: { status: 'unknown', signatures: [{ status: 'unknown', diagnostic: 'EMPTY_FIELD', field: 'Signature', certificate: {} }] } });
  const body = new Response(route.request().postDataBuffer(), { headers: { 'content-type': route.request().headers()['content-type'] } });
  const form = await body.formData(); const file = form.get('file');
  if (!file || typeof file === 'string') throw new Error('Expected multipart fixture');
  const name = byDigest.get(digest(new Uint8Array(await file.arrayBuffer())));
  if (action === 'probe') return route.fulfill({ json: { encrypted: name?.startsWith('example_') || false, format: name?.endsWith('.xls') ? 'xls97' : 'ooxml' } });
  if (action === 'unlock') {
    if (form.get('password') !== 'Password1234_') return route.fulfill({ status: 422, json: { code: 'WRONG_PASSWORD' } });
    return route.fulfill({ contentType: 'application/octet-stream', body: fileBytes(name?.endsWith('.xlsx') ? 'unlocked-example.xlsx' : 'unlocked-example.docx') });
  }
  if (action === 'cards' || action === 'eml-parse') {
    const name = action === 'eml-parse' ? 'message.eml' : form.get('kind') === 'ics' ? 'events.ics' : 'contacts.vcf';
    return route.fulfill({ contentType: 'application/json', body: fileBytes(name + '.json') });
  }
  if (action === 'archive-index' || action === 'archive-extract') {
    const archives = JSON.parse(fileBytes('archive-fixtures.json').toString()) as Record<string, { index: unknown; files: Record<string, string> }>;
    const fixture = archives[String(form.get('filename'))];
    if (!fixture) throw new Error('Missing native archive fixture');
    return action === 'archive-index' ? route.fulfill({ json: fixture.index }) : route.fulfill({ contentType: 'application/octet-stream', body: Buffer.from(fixture.files[String(form.get('entry'))], 'base64') });
  }
  if (action === 'eml-part') return route.fulfill({ contentType: 'application/octet-stream', body: 'Nested EML attachment bytes\n' });
  throw new Error('Unexpected processing action');
}

/** Authenticate the real processor even in composer-only tests with mocked mail data. */
export async function authenticateAttachmentProcessing(page: Page): Promise<void> {
  if (process.env.ATTACHMENT_LIVE_PROCESSING === '1') {
    const origin = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4173';
    let cookies = sessions.get(origin);
    if (!cookies) {
      const login = await page.request.post('/api/auth/login', { headers: { 'X-Requested-With': 'MailFlow' }, data: { username: process.env.PLAYWRIGHT_USERNAME, password: process.env.PLAYWRIGHT_PASSWORD } });
      expect(login.ok()).toBe(true);
      cookies = await page.context().cookies(); sessions.set(origin, cookies);
    }
    await page.context().addCookies(cookies);
  }
}

export async function attachmentMessage(page: Page, names: string[], options: { theme?: string; grouped?: boolean } = {}) {
  Object.assign(page, { __languageOverride: 'en', __themeOverride: options.theme || 'light', __conversationMatrix: options.grouped ? '11' : '00', __noNativeThread: !options.grouped });
  const attachments = names.map(name => ({ part: name, filename: name, size: fileBytes(name).length, type: 'application/octet-stream' }));
  await page.route('**/api/mail/messages/*/body**', route => route.fulfill({ json: { html: '<p>Attachment message body</p>', text: 'Attachment message body', attachments } }));
  await page.route('**/api/mail/messages/*/attachments/*', route => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    return route.fulfill({ contentType: 'application/octet-stream', headers: { 'cache-control': 'no-store', 'x-attachment-scan': 'disabled' }, body: fileBytes(name) });
  });
  await page.route('**/api/mail/attachments/process/*', processing);
  await authenticateAttachmentProcessing(page);
  {
    const nginx = readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8');
    const policy = [...nginx.matchAll(/add_header Content-Security-Policy\s+"([^"]+)"/g)].map(match => match[1]).find(value => value.includes('wss: ws:'));
    if (!policy) throw new Error('Production CSP not found');
    await page.route(url => url.pathname === '/', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } });
    });
  }
  await page.goto('/?list=0&reader=0');
  await expect(page.locator('[data-ce-reader-enabled]:visible').first()).toHaveAttribute('data-ce-reader-enabled', options.grouped ? 'true' : 'false');
  await page.locator(`[data-msgid="conversation-gmail-copy-${options.grouped ? 5 : 1}"]:visible`).click();
  await expect(page.locator('[data-message-detail-attachment]').first()).toBeVisible();
}

export async function preview(page: Page, filename: string) {
  await page.locator(`[data-message-detail-attachment="${filename}"]:visible`).first().click();
  const dialog = page.getByTestId('attachment-preview-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}
