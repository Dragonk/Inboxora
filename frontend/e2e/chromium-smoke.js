import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ locale: 'pl-PL' });
try {
  await page.goto('http://127.0.0.1:4173', { waitUntil: 'domcontentloaded' });
  console.log(JSON.stringify({ chromium: true, locale: 'pl-PL', url: page.url() }));
} finally {
  await browser.close();
}
