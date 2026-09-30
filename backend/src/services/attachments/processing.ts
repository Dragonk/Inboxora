import { OfficeFile, OOXMLFile, OleFileIO, FileFormatError, InvalidKeyError } from 'office-crypto';
import { simpleParser } from 'mailparser';
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
  const mail = await simpleParser(Buffer.from(input.bytes), { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true, maxHtmlLengthToParse: 2 * 1024 * 1024 });
  if (mail.attachments.length > 100 || mail.attachments.reduce((n, part) => n + part.size, 0) > FILE_LIMIT) throw new AttachmentProcessingError('LIMIT');
  if (input.action === 'eml-part') {
    if (!Number.isInteger(input.index) || input.index! < 0 || input.index! >= mail.attachments.length) throw new AttachmentProcessingError('INVALID_INPUT');
    const part = mail.attachments[input.index!]; return { bytes: part.content, filename: part.filename || 'attachment', type: part.contentType };
  }
  const html = typeof mail.html === 'string' ? mail.html : ''; const text = mail.text || '';
  if (html.length + text.length > 2 * 1024 * 1024) throw new AttachmentProcessingError('LIMIT');
  return { json: { html, text, subject: mail.subject || '', from: mail.from?.text || '', date: mail.date?.toISOString() || '',
    attachments: mail.attachments.map((part, index) => ({ index, filename: part.filename || 'attachment', type: part.contentType, size: part.size })),
  } };
}
