import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ locale: 'pl-PL' });
try {
  const response = await page.goto('http://127.0.0.1:4173', { waitUntil: 'domcontentloaded' });
  if (!response || !response.ok()) throw new Error(`Frontend response failed: ${response?.status()}`);
  await page.locator('#root').waitFor();
  console.log(JSON.stringify({ chromium: true, locale: 'pl-PL', url: page.url() }));
} finally {
  await browser.close();
}
