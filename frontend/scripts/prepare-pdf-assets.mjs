import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const directory of ['cmaps', 'standard_fonts']) {
  mkdirSync(resolve(root, 'public/pdf-assets', directory), { recursive: true });
  cpSync(resolve(root, 'node_modules/pdfjs-dist', directory), resolve(root, 'public/pdf-assets', directory), { recursive: true });
}
cpSync(resolve(root, 'node_modules/pdfjs-dist/LICENSE'), resolve(root, 'public/pdf-assets/LICENSE'));
