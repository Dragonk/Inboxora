#!/usr/bin/env node
//
// Compare regenerated documentation screenshots with the committed ones.
//
// A byte-for-byte comparison would be flaky: text antialiasing differs slightly between
// machines and Chromium builds even when the interface is identical. This compares pixels
// with the same tolerance the visual regression spec uses (`maxDiffPixelRatio`), so a real
// change (a moved panel, a renamed label, an empty state) fails while sub-pixel rendering
// noise does not.
//
// Usage:
//   node scripts/compare-docs-screenshots.mjs <baselineDir> <candidateDir> [--max-diff-ratio 0.002] [--diff-dir <dir>]
//
// Exits 0 when every image is within tolerance, 1 otherwise. Diff images for the failing
// captures are written to --diff-dir when given.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'frontend', 'package.json'));
const { PNG } = require('playwright-core/lib/utilsBundle');

const [baselineDir, candidateDir, ...rest] = process.argv.slice(2);
if (!baselineDir || !candidateDir) {
  console.error('Usage: node scripts/compare-docs-screenshots.mjs <baselineDir> <candidateDir> [--max-diff-ratio 0.002] [--diff-dir <dir>]');
  process.exit(2);
}

let maxDiffRatio = 0.002;
let diffDir = null;
for (let index = 0; index < rest.length; index += 1) {
  if (rest[index] === '--max-diff-ratio') maxDiffRatio = Number(rest[index + 1]);
  else if (rest[index] === '--diff-dir') diffDir = rest[index + 1];
}

const pngFiles = dir => readdirSync(dir).filter(name => name.endsWith('.png')).sort();
const baseline = pngFiles(baselineDir);
const candidate = pngFiles(candidateDir);

const failures = [];
const missing = baseline.filter(name => !candidate.includes(name));
const added = candidate.filter(name => !baseline.includes(name));
for (const name of missing) failures.push(`${name} was not regenerated.`);
for (const name of added) failures.push(`${name} is new and has no committed version to compare with.`);

/** Reads a PNG into a flat RGB view. */
function readPixels(file) {
  const png = PNG.sync.read(readFileSync(file));
  return { width: png.width, height: png.height, data: png.data };
}

let compared = 0;
let worst = { name: null, ratio: 0 };

for (const name of baseline.filter(entry => candidate.includes(entry))) {
  const left = readPixels(join(baselineDir, name));
  const right = readPixels(join(candidateDir, name));

  if (left.width !== right.width || left.height !== right.height) {
    failures.push(`${name} changed size: ${left.width}×${left.height} → ${right.width}×${right.height}.`);
    continue;
  }

  const total = left.width * left.height;
  // Antialiasing differences are spread thinly; a real change moves contiguous regions.
  const threshold = 12; // per-channel sum, i.e. roughly 4 levels on one channel
  let differing = 0;
  let diffImage = null;
  for (let index = 0; index < left.data.length; index += 4) {
    const delta = Math.abs(left.data[index] - right.data[index])
      + Math.abs(left.data[index + 1] - right.data[index + 1])
      + Math.abs(left.data[index + 2] - right.data[index + 2]);
    if (delta <= threshold) continue;
    differing += 1;
    if (diffDir) {
      if (!diffImage) diffImage = Buffer.from(right.data);
      diffImage[index] = 255;
      diffImage[index + 1] = 0;
      diffImage[index + 2] = 0;
    }
  }

  compared += 1;
  const ratio = differing / total;
  if (ratio > worst.ratio) worst = { name, ratio };
  if (ratio > maxDiffRatio) {
    failures.push(`${name} differs in ${differing} of ${total} pixels (${(ratio * 100).toFixed(2)}%, limit ${(maxDiffRatio * 100).toFixed(2)}%).`);
    if (diffDir && diffImage) {
      mkdirSync(diffDir, { recursive: true });
      const out = PNG.sync.write({ width: right.width, height: right.height, data: diffImage });
      writeFileSync(join(diffDir, name), out);
    }
  }
}

if (failures.length) {
  console.error(`Documentation screenshots are out of date (${failures.length} problem(s)):\n`);
  for (const message of failures) console.error(`  - ${message}`);
  if (diffDir) console.error(`\nDiff images (differences highlighted in red): ${diffDir}`);
  console.error('\nRegenerate with: cd frontend && npm run build && npm run docs:screenshots');
  process.exit(1);
}

console.log(`Documentation screenshots match the committed set: ${compared} images compared, worst ${worst.name} at ${(worst.ratio * 100).toFixed(3)}% (limit ${(maxDiffRatio * 100).toFixed(2)}%).`);
