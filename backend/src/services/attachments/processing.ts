import { OfficeFile, OOXMLFile, OleFileIO, FileFormatError, InvalidKeyError } from 'office-crypto';
import { MailParser, type AttachmentStream, type MessageText, type Headers } from 'mailparser';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseVCard, splitVCards } from '../../utils/vcard.js';
import { calendarResources } from '../../utils/calendarRecurrence.js';
import { parseCalendarEvent } from '../../utils/ical.js';

export const FILE_LIMIT = 50 * 1024 * 1024;
export type ProcessingAction = 'probe' | 'unlock' | 'eml-parse' | 'eml-part' | 'cards';
export interface ProcessingInput { action: ProcessingAction; bytes: Uint8Array; password?: string; index?: number; kind?: string }
export interface ProcessingOutput { json?: Record<string, unknown>; bytes?: Uint8Array; filename?: string; type?: string }
export class AttachmentProcessingError extends Error {
  constructor(public code: 'LIMIT' | 'WRONG_PASSWORD' | 'UNSUPPORTED' | 'CORRUPT' | 'INVALID_INPUT' | 'CANCELLED') { super(code); }
}
function compound(bytes: Uint8Array): boolean { return [208, 207, 17, 224, 161, 177, 26, 225].every((byte, index) => bytes[index] === byte); }
/** This function runs only in a disposable worker. No document data is logged or persisted. */
export async function processAttachment(input: ProcessingInput): Promise<ProcessingOutput> {
  if (!input.bytes.length || input.bytes.byteLength > FILE_LIMIT) throw new AttachmentProcessingError('LIMIT');
  if (input.action === 'probe' || input.action === 'unlock') {
    if (!compound(input.bytes)) {
      if (input.action === 'unlock') throw new AttachmentProcessingError('UNSUPPORTED');
      return { json: { encrypted: false, format: 'other' } };
    }
    // Bound the declared plaintext length before a crypto implementation may allocate it.
    const container = new OleFileIO(input.bytes);
    if (container.exists('EncryptedPackage')) {
      const packed = container.openstream('EncryptedPackage').getValue();
      if (packed.byteLength < 8) throw new AttachmentProcessingError('CORRUPT');
      const length = new DataView(packed.buffer, packed.byteOffset, packed.byteLength).getBigUint64(0, true);
      if (length > BigInt(FILE_LIMIT)) throw new AttachmentProcessingError('LIMIT');
    }
    let file;
    try { file = OfficeFile(input.bytes); }
    catch (error) { throw new AttachmentProcessingError(error instanceof FileFormatError ? 'UNSUPPORTED' : 'CORRUPT'); }
    const encrypted = file.isEncrypted();
    if (input.action === 'probe') return { json: { encrypted, format: file.format, encryption: file instanceof OOXMLFile ? file.type : file.format } };
    if (!encrypted || !input.password || input.password.length > 256) throw new AttachmentProcessingError('INVALID_INPUT');
    try { file.loadKey({ password: input.password, verifyPassword: true }); }
    catch (error) { throw new AttachmentProcessingError(error instanceof InvalidKeyError ? 'WRONG_PASSWORD' : 'UNSUPPORTED'); }
    let result: Uint8Array;
    try { result = file.decrypt({ verifyIntegrity: true }); }
    catch { throw new AttachmentProcessingError('CORRUPT'); }
    if (result.byteLength > FILE_LIMIT) throw new AttachmentProcessingError('LIMIT');
    return { bytes: result, type: 'application/octet-stream' };
  }
  if (input.action === 'cards') {
    if (input.bytes.length > 900000) throw new AttachmentProcessingError('LIMIT');
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
    if (input.kind === 'vcf') {
      const cards = splitVCards(raw); if (!cards.length || cards.length > 100) throw new AttachmentProcessingError('LIMIT');
      return { json: { cards: cards.map(value => { const card = parseVCard(value); return {
        raw: value, title: card.displayName || card.emails[0]?.value || '',
        details: [...card.emails.map(email => email.value), ...card.phones.map(phone => phone.value), card.organization].filter(Boolean),
      }; }) } };
    }
    if (input.kind !== 'ics') throw new AttachmentProcessingError('INVALID_INPUT');
    const resources = calendarResources(raw); if (!resources.length || resources.length > 100) throw new AttachmentProcessingError('LIMIT');
    return { json: { cards: resources.map(value => {
      const event = parseCalendarEvent(value); if (!event) throw new AttachmentProcessingError('CORRUPT');
      return { raw: value, title: event.summary || '', details: [event.location, event.organizer].filter(Boolean), startsAt: event.startsAt.toISOString(), endsAt: event.endsAt.toISOString(), allDay: event.allDay };
    }) } };
  }
  if (input.action !== 'eml-parse' && input.action !== 'eml-part') throw new AttachmentProcessingError('INVALID_INPUT');
  return processEml(input);
}

/** Stream MIME attachments; keep metadata and only the explicitly requested part.
 * Lower ceilings support boundary tests; callers cannot raise production limits. */
export async function processEml(input: ProcessingInput, ceilings = { parts: 100, bytes: FILE_LIMIT }): Promise<ProcessingOutput> {
  const partLimit = Math.min(100, ceilings.parts);
  const byteLimit = Math.min(FILE_LIMIT, ceilings.bytes);
  if (input.action === 'eml-part' && (!Number.isInteger(input.index) || input.index! < 0 || input.index! >= partLimit)) {
    throw new AttachmentProcessingError('INVALID_INPUT');
  }
  const parser = new MailParser({ skipHtmlToText: true, skipTextToHtml: true, skipTextLinks: true, skipImageLinks: true, maxHtmlLengthToParse: 2 * 1024 * 1024 });
  const source = Readable.from((function* () {
    for (let offset = 0; offset < input.bytes.length; offset += 65536) yield input.bytes.subarray(offset, offset + 65536);
  })());
  let headers: Headers = new Map();
  parser.on('headers', (value: Headers) => { headers = value; });
  const attachments: Array<{ index: number; filename: string; type: string; size: number }> = [];
  let total = 0; let html = ''; let text = ''; let selected: ProcessingOutput | undefined;
  let activeContent: Readable | undefined;
  const collect = async () => {
    // MailParser documents these two output types; Node's generic iterator is untyped.
    for await (const part of parser as AsyncIterable<AttachmentStream | MessageText>) {
      if (part.type === 'text') {
        html = typeof part.html === 'string' ? part.html : ''; text = part.text || '';
        if (Buffer.byteLength(html) + Buffer.byteLength(text) > 2 * 1024 * 1024) throw new AttachmentProcessingError('LIMIT');
        continue;
      }
      if (attachments.length >= partLimit) throw new AttachmentProcessingError('LIMIT');
      if (!(part.content instanceof Readable)) throw new AttachmentProcessingError('CORRUPT');
      activeContent = part.content;
      const index = attachments.length; let size = 0; const chunks: Buffer[] = [];
      try {
        for await (const chunk of part.content) {
          if (!Buffer.isBuffer(chunk)) throw new AttachmentProcessingError('CORRUPT');
          size += chunk.length; total += chunk.length;
          if (size > byteLimit || total > byteLimit) throw new AttachmentProcessingError('LIMIT');
          if (input.action === 'eml-part' && index === input.index) chunks.push(chunk);
        }
      } finally { part.release(); }
      activeContent = undefined;
      const item = { index, filename: part.filename || 'attachment', type: part.contentType, size };
      attachments.push(item);
      if (input.action === 'eml-part' && index === input.index) selected = { bytes: Buffer.concat(chunks, size), filename: item.filename, type: item.type };
    }
  };
  try { await Promise.all([pipeline(source, parser), collect()]); }
  catch (error) {
    activeContent?.destroy(); source.destroy(); parser.destroy();
    throw error instanceof AttachmentProcessingError ? error : new AttachmentProcessingError('CORRUPT');
  }
  if (input.action === 'eml-part') {
    if (!selected) throw new AttachmentProcessingError('INVALID_INPUT');
    return selected;
  }
  const subject = headers.get('subject'); const from = headers.get('from'); const date = headers.get('date');
  return { json: { html, text, attachments,
    subject: typeof subject === 'string' ? subject : '',
    from: from && typeof from === 'object' && 'text' in from && typeof from.text === 'string' ? from.text : '',
    date: date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : '',
  } };
}
