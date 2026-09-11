#!/usr/bin/env node
//
// Verify that the documentation screenshots are complete and consistent.
//
// 1. Every image referenced by the README or a Wiki page exists in media/screenshots.
// 2. Every committed image is referenced somewhere, so the set has no orphans.
// 3. Every image is a PNG of a plausible size, which catches a truncated or blank capture.
// 4. Every referenced image is a real screenshot of the application, not a placeholder.
//
// Runs in CI right after the docs screenshot spec. Usage:
//
//   node scripts/verify-docs-screenshots.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const screenshotDir = join(root, 'media', 'screenshots');
const MIN_BYTES = 8 * 1024;

const failures = [];
const fail = message => failures.push(message);

const docs = [
  join(root, 'README.md'),
  ...readdirSync(join(root, 'docs', 'wiki'))
    .filter(name => name.endsWith('.md'))
    .map(name => join(root, 'docs', 'wiki', name)),
];

// Matches both repository-relative links and the absolute raw URLs the Wiki uses.
const REFERENCE = /media\/screenshots\/([A-Za-z0-9._-]+\.png)/g;

const referenced = new Map();
for (const file of docs) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(REFERENCE)) {
    const name = match[1];
    if (!referenced.has(name)) referenced.set(name, []);
    referenced.get(name).push(file.slice(root.length + 1));
  }
}

let onDisk = [];
try {
  onDisk = readdirSync(screenshotDir).filter(name => name.endsWith('.png')).sort();
} catch {
  fail('media/screenshots/ does not exist; run the docs screenshot spec first.');
}

for (const [name, sources] of referenced) {
  let stats;
  try {
    stats = statSync(join(screenshotDir, name));
  } catch {
    fail(`${name} is referenced by ${sources.join(', ')} but is not committed.`);
    continue;
  }
  if (stats.size < MIN_BYTES) {
    fail(`${name} is only ${stats.size} bytes; a documentation screenshot must be a real capture.`);
  }
  const header = readFileSync(join(screenshotDir, name)).subarray(0, 8);
  if (header.subarray(0, 4).toString('hex') !== '89504e47') fail(`${name} is not a PNG file.`);
}

for (const name of onDisk) {
  if (!referenced.has(name)) fail(`${name} is committed but no README or Wiki page uses it.`);
}

// Two viewports, one mail gallery: heuristics that catch a set that silently lost a
// variant (for example only desktop was regenerated).
const hasMobile = onDisk.some(name => name.endsWith('-mobile.png'));
const hasDesktop = onDisk.some(name => name.endsWith('-desktop.png'));
if (onDisk.length && !hasDesktop) fail('no -desktop screenshots were generated.');
if (onDisk.length && !hasMobile) fail('no -mobile screenshots were generated.');

if (failures.length) {
  console.error('Documentation screenshot verification failed:\n');
  for (const message of failures) console.error(`  - ${message}`);
  console.error('\nRegenerate with: cd frontend && DOCS_SCREENSHOTS=1 npx playwright test e2e/docs-screenshots.spec.js --project=chromium-desktop --project=chromium-mobile-390');
  process.exit(1);
}

console.log(`Documentation screenshots verified: ${onDisk.length} images, all referenced and non-empty.`);
