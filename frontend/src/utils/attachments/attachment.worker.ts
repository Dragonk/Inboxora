import { SaxesParser } from 'saxes';
import { archiveIndex, archiveExtract, officeEntries } from './zip.ts';
import { decodeText } from './decodeText.ts';
import { IMAGE_PIXEL_LIMIT, TEXT_LIMIT } from './types.ts';
import type { AttachmentOperations, TextData, SheetData } from './workerClient.ts';
import { isZip } from './attachmentKind.ts';

/** Count spreadsheet expansion before allocating cells. */
async function checkWorkbookXml(entries: Array<{ name: string; blob: Blob }>): Promise<void> {
  let cells = 0;
  for (const entry of entries) {
    if (!entry.name.endsWith('.xml')) continue;
    const parser = new SaxesParser({ xmlns: true }); let rows = 1;
    parser.on('doctype', () => { throw new Error('UNSUPPORTED'); });
    parser.on('opentag', tag => {
      const repeat = (name: string) => {
        const attribute = Object.values(tag.attributes).find(item => item.local === name);
        const value = attribute ? Number(attribute.value) : 1;
        if (!Number.isSafeInteger(value) || value < 1 || value > 10000) throw new Error('LIMIT');
        return value;
      };
      if (tag.local === 'table-row') rows = repeat('number-rows-repeated');
      if (tag.local === 'table-cell' || tag.local === 'covered-table-cell') cells += rows * repeat('number-columns-repeated');
      else if (tag.local === 'c' || tag.local === 'si') cells++;
      if (cells > 500000) throw new Error('LIMIT');
    });
    parser.on('closetag', tag => { if (tag.local === 'table-row') rows = 1; });
    parser.write(await entry.blob.text()).close();
  }
}

type WorkRequest = { [K in keyof AttachmentOperations]: { kind: K; input: AttachmentOperations[K]['input'] } }[keyof AttachmentOperations];
export async function processWork(request: WorkRequest): Promise<unknown> {
  const { input } = request;
  if (request.kind === 'index') return archiveIndex(input.blob);
  if (request.kind === 'package') return officeEntries(input.blob);
  if (request.kind === 'extract') return archiveExtract(request.input.blob, request.input.name, request.input.remaining);
  if (request.kind === 'tiff') {
    const { default: UTIF } = await import('utif'); const buffer = await input.blob.arrayBuffer();
    const pages = UTIF.decode(buffer); const page = pages[0];
    if (!page) throw new Error('CORRUPT');
    const width = Number(Array.isArray(page.t256) ? page.t256[0] : page.t256); const height = Number(Array.isArray(page.t257) ? page.t257[0] : page.t257);
    if (!Number.isSafeInteger(width * height) || width < 1 || height < 1 || width * height > IMAGE_PIXEL_LIMIT) throw new Error('LIMIT');
    UTIF.decodeImage(buffer, page);
    return { rgba: new Uint8Array(UTIF.toRGBA8(page)), width, height };
  }
  if (request.kind === 'sheet') {
    const bytes = new Uint8Array(await input.blob.arrayBuffer());
    if (isZip(bytes)) await checkWorkbookXml(await officeEntries(input.blob));
    const XLSX = await import('xlsx');
    const header = XLSX.read(bytes, { type: 'array', bookSheets: true });
    if (header.SheetNames.length > 100) throw new Error('LIMIT');
    const requested = request.input.sheet && header.SheetNames.includes(request.input.sheet) ? request.input.sheet : header.SheetNames[0];
    if (!requested) throw new Error('CORRUPT');
    const workbook = XLSX.read(bytes, { type: 'array', sheets: requested, sheetRows: isZip(bytes) ? 10001 : 1953, cellHTML: false, cellFormula: false, cellStyles: false, bookVBA: false, dense: false });
    if (workbook.SheetNames.length > 100) throw new Error('LIMIT');
    const name = request.input.sheet && workbook.SheetNames.includes(request.input.sheet) ? request.input.sheet : workbook.SheetNames[0];
    if (!name) throw new Error('CORRUPT');
    const sheet = workbook.Sheets[name]; const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    const columns = Math.min(256, range.e.c + 1); const end = Math.min(range.e.r, 9999, Math.floor(500000 / columns) - 1);
    // Sparse cells avoid allocating an entire row out to a hostile far-away column.
    // Bound formatted output before cloning it across the worker boundary as well.
    const rows: string[][] = []; let characters = 0; let outputLimited = false;
    outer: for (let r = 0; r <= end; r++) {
      const row: string[] = [];
      for (let c = 0; c < columns; c++) {
        const cell: import('xlsx').CellObject | undefined = sheet[XLSX.utils.encode_cell({ r, c })];
        const value = cell ? XLSX.utils.format_cell(cell) : '';
        characters += value.length;
        if (characters > 4 * 1024 * 1024) { outputLimited = true; break outer; }
        row.push(value);
      }
      rows.push(row);
    }
    if (!rows.length) throw new Error('LIMIT');
    return { names: workbook.SheetNames, sheet: name, rows, limited: outputLimited || range.e.r > end || range.e.c >= columns || Boolean(sheet['!fullref']) } satisfies SheetData;
  }
  if (request.kind === 'text') {
    if (input.blob.size > TEXT_LIMIT) throw new Error('LIMIT');
    const decoded = decodeText(new Uint8Array(await input.blob.arrayBuffer()), request.input.encoding ? `text/plain; charset=${request.input.encoding}` : request.input.type);
    const result: TextData = { text: decoded.text, raw: decoded.text, encoding: decoded.encoding, failed: false };
    try {
      if (request.input.kind === 'json') {
        const { parse, format, applyEdits } = await import('jsonc-parser'); const errors: import('jsonc-parser').ParseError[] = [];
        parse(decoded.text, errors, { allowTrailingComma: true });
        if (errors.length) throw new Error('CORRUPT');
        result.text = applyEdits(decoded.text, format(decoded.text, undefined, { tabSize: 2, insertSpaces: true }));
      } else if (request.input.kind === 'xml') {
        if (/<!DOCTYPE|<!ENTITY/i.test(decoded.text)) throw new Error('CORRUPT');
        new SaxesParser({ xmlns: true }).write(decoded.text).close();
        const { default: format } = await import('xml-formatter'); result.text = format(decoded.text, { indentation: '  ', throwOnFailure: true });
      } else if (request.input.kind === 'csv') {
        const { default: Papa } = await import('papaparse');
        const parsed = Papa.parse<string[]>(decoded.text, { preview: 10001, skipEmptyLines: true });
        if (parsed.errors.length) throw new Error('CORRUPT');
        result.rows = parsed.data.slice(0, 10000).map(row => row.slice(0, 256));
        result.limited = parsed.data.length > 10000 || parsed.data.some(row => row.length > 256) || Boolean(parsed.meta.truncated);
        if (result.rows.reduce((n, row) => n + row.length, 0) > 500000) throw new Error('LIMIT');
      }
    } catch { result.failed = true; }
    return result;
  }
  throw new Error('UNSUPPORTED');
}
if (typeof self !== 'undefined') self.onmessage = (event: MessageEvent<WorkRequest>) => {
  void processWork(event.data).then(result => self.postMessage({ result })).catch((error: unknown) => {
    const code = error instanceof Error && ['LIMIT', 'ENCRYPTED_ZIP', 'UNSUPPORTED'].includes(error.message) ? error.message : 'CORRUPT';
    self.postMessage({ error: code });
  });
};
