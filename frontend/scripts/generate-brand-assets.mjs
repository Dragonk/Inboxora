// Run with PLAYWRIGHT_BROWSERS_PATH configured after installing Chromium.
import { chromium } from '@playwright/test';
import { writeFile, copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { brandSvg } from '../src/brandMark.js';
const root = new URL('../', import.meta.url);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const render = async (size, path, options) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:100vw;height:100vh;display:block}</style>${brandSvg(undefined, options)}`);
    await page.screenshot({ path: fileURLToPath(new URL(path, root)), omitBackground: true });
  };
  await writeFile(new URL('public/favicon.svg', root), brandSvg());
  for (const size of [32, 72, 96, 128, 144, 152, 180, 192, 384, 512]) {
    await render(size, `public/inboxora-icon-${size}.png`);
    if ([180, 192, 512].includes(size)) await copyFile(new URL(`public/inboxora-icon-${size}.png`, root), new URL(`public/inboxora-envelope-${size}.png`, root));
  }
  await render(512, 'public/inboxora-envelope-maskable-512.png', { maskable: true });
  await render(96, 'public/inboxora-envelope-badge.png', { badge: true });
  await copyFile(new URL('public/inboxora-icon-512.png', root), new URL('../media/inboxora-logo.png', root));
  for (const [density, size] of [['mdpi',48],['hdpi',72],['xhdpi',96],['xxhdpi',144],['xxxhdpi',192]]) {
    const dir = `packages/android/app/src/main/res/mipmap-${density}`;
    await mkdir(new URL(dir, root), { recursive: true });
    for (const name of ['ic_launcher', 'ic_launcher_round']) await render(size, `${dir}/${name}.png`);
    await render(Math.round(size * 2.25), `${dir}/ic_launcher_foreground.png`, { maskable: true, badge: true });
  }
} finally { await browser.close(); }
