// Synthetic spreadsheet/archive fixtures. CI consumes the checked-in bytes.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js/index-native.js';
const root = fileURLToPath(new URL('../../backend/fixtures/attachments/', import.meta.url));
const workbook = XLSX.utils.book_new();
const sheet = XLSX.utils.aoa_to_sheet([['Item', 'Quantity', 'Price'], ['Preview widget', 2, 1234.5], ['Second row', 3, 12]]);
sheet.C2.z = '#,##0.00';
XLSX.utils.book_append_sheet(workbook, sheet, 'Inventory');
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Notes'], ['Second worksheet text']]), 'Notes');
for (const [extension, bookType] of [['xlsx', 'xlsx'], ['xls', 'biff8'], ['ods', 'ods']]) {
  writeFileSync(root + 'workbook.' + extension, XLSX.write(workbook, { type: 'buffer', bookType }));
}
const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false, useCompressionStream: true });
await writer.add('secret.txt', new BlobReader(new Blob(['Encrypted ZIP fixture'])), { password: 'archive-password' });
writeFileSync(root + 'encrypted.zip', Buffer.from(await (await writer.close()).arrayBuffer()));
console.log('Generated spreadsheet and encrypted ZIP fixtures.');
