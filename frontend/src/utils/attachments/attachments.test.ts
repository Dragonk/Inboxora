import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectKind, isZip, isImageKind } from './attachmentKind.ts';
import { decodeText } from './decodeText.ts';
import { imageDimensions } from './imageDimensions.ts';
import { archiveIndex, archiveExtract, officeEntries, safeArchiveName } from './zip.ts';
import { processWork } from './attachment.worker.ts';
import { findMatches } from './find.ts';
const bytes = (name: string) => new Uint8Array(readFileSync(new URL(`../../../../backend/fixtures/attachments/${name}`, import.meta.url)));
const blob = (name: string) => new Blob([bytes(name)]);

test('all agreed attachment formats route by extension and validated signatures', () => {
  const formats = {
    'image.png':'image', 'image.jpg':'image', 'image.gif':'image', 'image.webp':'image', 'image.avif':'image', 'image.bmp':'image',
    'image.tiff':'tiff', 'image.svg':'svg', 'hundred-pages.pdf':'pdf', 'document.docx':'docx', 'workbook.xlsx':'sheet', 'workbook.xls':'office', 'workbook.ods':'sheet',
    'example_password.docx':'office', 'example_password.xlsx':'office', 'data.json':'json', 'data.jsonc':'json', 'data.xml':'xml', 'data.csv':'csv', 'data.tsv':'csv',
    'notes.md':'markdown', 'text.txt':'text', 'archive.zip':'zip', 'audio.mp3':'audio', 'audio.ogg':'audio', 'audio.wav':'audio', 'video.mp4':'video', 'video.webm':'video',
    'document.html':'html', 'message.eml':'eml', 'events.ics':'ics', 'contacts.vcf':'vcf', 'presentation.pptx':'unsupported', 'legacy.doc':'unsupported',
    'legacy.ppt':'unsupported', 'document.odt':'unsupported', 'presentation.odp':'unsupported', 'unknown.bin':'unsupported',
  } as const;
  for (const [name, expected] of Object.entries(formats)) assert.equal(detectKind(name,'application/octet-stream',bytes(name).subarray(0,4096)), expected, name);
  assert.equal(detectKind('invoice.txt','image/png',bytes('hundred-pages.pdf')), 'pdf');
  assert.equal(detectKind('fake.png','image/png',bytes('text.txt')), 'unsupported');
  assert.equal(detectKind('payload.exe','application/pdf',bytes('hundred-pages.pdf')), 'unsupported');
  assert.equal(isZip(new Uint8Array([80,75,3,8])), false);
  assert.equal(isImageKind('pdf'),false);
});
test('BOM and declared encodings take precedence; invalid UTF-8 uses the Polish fallback', () => {
  assert.deepEqual(decodeText(bytes('polish.txt')), {text:'Zażółć gęślą jaźń',encoding:'windows-1250',fallback:true});
  assert.equal(decodeText(new Uint8Array([255,254,65,0]), 'text/plain;charset=windows-1250').text, 'A');
  assert.equal(decodeText(new Uint8Array([254,255,0,66])).text,'B');
  assert.equal(decodeText(new Uint8Array([0x80]), 'text/plain;charset=windows-1252').text,'€');
});
test('raster headers are dimension-checked before browser decode', () => {
  for (const ext of ['png','jpg','gif','webp','avif','bmp']) assert.deepEqual(imageDimensions(bytes(`image.${ext}`)),{width:180,height:100},ext);
  const huge=bytes('image.png');new DataView(huge.buffer).setUint32(16,100000);
  assert.throws(()=>imageDimensions(huge),/LIMIT/);
});
test('ZIP listing does not expand entries; selected entries share the safety policy',async()=>{
  const archive=blob('archive.zip');const index=await archiveIndex(archive);
  assert.ok(index.entries.some(entry=>entry.name==='hundred-pages.pdf'));
  const pdf=await archiveExtract(archive,'hundred-pages.pdf',50*1024*1024);
  assert.deepEqual(new Uint8Array(await pdf.arrayBuffer()),bytes('hundred-pages.pdf'));
  await assert.rejects(archiveExtract(archive,'hundred-pages.pdf',1),/LIMIT/);
  const encrypted=await archiveIndex(blob('encrypted.zip'));assert.equal(encrypted.entries[0].encrypted,true);
  await assert.rejects(archiveExtract(blob('encrypted.zip'),'secret.txt',10000),/ENCRYPTED_ZIP/);
});
test('ZIP traversal, symlinks, oversized expanded entries and excessive counts are rejected',async()=>{
  for (const name of ['unsafe-path.zip','symlink.zip','large-entry.zip','too-many.zip']) await assert.rejects(archiveIndex(blob(name)),/LIMIT/,name);
  for (const name of ['../a','/a','C:/a','a\\b','a/./b','a\u0000b']) assert.equal(safeArchiveName(name),false,name);
  assert.equal(safeArchiveName('folder/Zażółć.txt'),true);
});
test('Office packages are fully checked before a parser can expand their content',async()=>{
  const entries=await officeEntries(blob('document.docx'));assert.ok(entries.some(entry=>entry.name==='word/document.xml'));
  await assert.rejects(officeEntries(blob('large-entry.zip')),/LIMIT/);
});
test('JSONC pretty printing preserves comments, order and integers beyond binary64 precision',async()=>{
  const result=await processWork({kind:'text',input:{blob:blob('data.jsonc'),type:'application/json',kind:'json'}}) as {text:string;failed:boolean};
  assert.equal(result.failed,false);assert.match(result.text,/Preserve this comment/);assert.match(result.text,/9007199254740993/);
  for (const [name,kind] of [['invalid.json','json'],['invalid.xml','xml']]) {
    const fallback=await processWork({kind:'text',input:{blob:blob(name),type:'text/plain',kind}}) as {text:string;raw:string;failed:boolean};
    assert.equal(fallback.failed,true);assert.equal(fallback.text,fallback.raw);assert.ok(fallback.raw.length);
  }
});
test('CSV quoting and every required spreadsheet format use bounded formatted tables',async()=>{
  const csv=await processWork({kind:'text',input:{blob:blob('data.csv'),type:'text/csv',kind:'csv'}}) as {rows:string[][]};
  assert.equal(csv.rows[1][0],'Fixture, One');assert.equal(csv.rows[2][2],'line one\nline two');
  for (const ext of ['xlsx','xls','ods']) {
    const result=await processWork({kind:'sheet',input:{blob:blob(`workbook.${ext}`)}}) as {names:string[];rows:string[][]};
    assert.deepEqual(result.names,['Inventory','Notes']);assert.equal(result.rows[1][0],'Preview widget');
    const second=await processWork({kind:'sheet',input:{blob:blob(`workbook.${ext}`),sheet:'Notes'}}) as {rows:string[][]};
    assert.equal(second.rows[1][0],'Second worksheet text');
  }
});
test('TIFF pixels are decoded through the worker operation',async()=>{
  const result=await processWork({kind:'tiff',input:{blob:blob('image.tiff')}}) as {width:number;height:number;rgba:Uint8Array};
  assert.equal(result.width,180);assert.equal(result.height,100);assert.equal(result.rgba.length,180*100*4);
});
test('find is literal, case insensitive and bounded rather than browser window.find',()=>{
  assert.deepEqual(findMatches('One needle, another NEEDLE.','needle'),[{start:4,end:10},{start:20,end:26}]);
  assert.deepEqual(findMatches('nothing',''),[]);
  assert.equal(findMatches('x'.repeat(11000),'x').length,10000);
});

test('find offsets remain correct after Unicode characters and literal regex punctuation', () => {
  assert.deepEqual(findMatches('İstanbul: needle 😀 needle', 'needle'), [{ start: 10, end: 16 }, { start: 20, end: 26 }]);
  assert.deepEqual(findMatches('a[b] a.b a+b', 'a.b'), [{ start: 5, end: 8 }]);
});

test('spreadsheet repeated-cell expansion is rejected before SheetJS allocation', async () => {
  const { BlobWriter, TextReader, ZipWriter } = await import('@zip.js/zip.js/index-native.js');
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false, level: 0 });
  await writer.add('content.xml', new TextReader('<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><table:table-row table:number-rows-repeated="10000"><table:table-cell table:number-columns-repeated="10000"/></table:table-row></office:document-content>'));
  const blob = await writer.close();
  await assert.rejects(processWork({ kind: 'sheet', input: { blob } }), /LIMIT/);
});

test('the passive DOCX fixture actually references both external image and HTML relationships', async () => {
  const entries = await officeEntries(blob('external-document.docx'));
  const body = await entries.find(entry => entry.name === 'word/document.xml')!.blob.text();
  const relationships = await entries.find(entry => entry.name === 'word/_rels/document.xml.rels')!.blob.text();
  assert.match(body, /<a:blip\b[^>]*r:link="rIdExternal"/);
  assert.match(body, /<w:altChunk\b[^>]*r:id="rIdChunk"/);
  for (const id of ['rIdExternal', 'rIdChunk']) {
    assert.match(relationships, new RegExp(`<Relationship\\b[^>]*Id="${id}"[^>]*TargetMode="External"`));
  }
});


test('loose archive signatures do not steal declared text or document formats', () => {
  const samples = [new TextEncoder().encode('BZh9 example text'), new TextEncoder().encode('a'.repeat(257) + 'ustar')];
  for (const sample of samples) {
    assert.equal(detectKind('notes.txt', 'text/plain', sample), 'text');
    assert.equal(detectKind('notes.md', 'text/markdown', sample), 'markdown');
    assert.equal(detectKind('document.docx', 'application/octet-stream', sample), 'unsupported');
    assert.equal(detectKind('document.pdf', 'application/octet-stream', sample), 'unsupported');
    assert.equal(detectKind('unknown', 'text/plain', sample), 'text');
    assert.equal(detectKind('unknown', 'application/octet-stream', sample), 'archive');
  }
  assert.equal(detectKind('notes.txt', 'text/plain', new Uint8Array([55,122,188,175,39,28])), 'archive');
  assert.equal(detectKind('file.bz2', '', new TextEncoder().encode('BZh9')), 'archive');
});
