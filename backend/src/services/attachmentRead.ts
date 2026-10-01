import type { FetchMessageObject, ImapFlow } from 'imapflow';

export const ATTACHMENT_READ_BYTES = 50 * 1024 * 1024;
export const ATTACHMENT_BATCH_BYTES = 150 * 1024 * 1024;
export class AttachmentReadLimitError extends Error {
  readonly code = 'LIMIT';
  constructor() { super('Attachment read limit exceeded'); }
}

/** The same aggregate budget is consumed before retaining provider bytes. */
export class AttachmentByteBudget {
  private used = 0;
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > ATTACHMENT_BATCH_BYTES) throw new AttachmentReadLimitError();
  }
  get remaining(): number { return this.limit - this.used; }
  consume(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.remaining) throw new AttachmentReadLimitError();
    this.used += bytes;
  }
}

/** Decode transfer encoding only. Never transcode a text attachment's charset or
 * unfold format=flowed: those transformations would alter the original file. */
export class AttachmentTransferDecoder {
  private pending = '';
  private ended = false;
  constructor(private readonly encoding: string) {}
  push(chunk: Buffer, final = false): Buffer {
    const encoding = this.encoding.toLowerCase();
    if (encoding !== 'base64' && encoding !== 'quoted-printable') return chunk;
    let source = this.pending + chunk.toString('latin1'); this.pending = '';
    if (encoding === 'base64') {
      source = source.replace(/[\r\n\t ]/g, '');
      if ((this.ended && source.length) || /[^A-Za-z0-9+/=]/.test(source)) throw new Error('Invalid attachment encoding');
      if (!final) {
        const count = source.length - source.length % 4;
        this.pending = source.slice(count); source = source.slice(0, count);
      }
      if (source.includes('=')) {
        if (!/^[A-Za-z0-9+/]*={1,2}$/.test(source)) throw new Error('Invalid attachment encoding');
        this.ended = true;
      }
      if (final && source.length % 4 === 1) throw new Error('Incomplete attachment encoding');
      return Buffer.from(source, 'base64');
    }
    if (!final) {
      const last = source.lastIndexOf('=');
      if (last >= source.length - 2 && last >= 0) { this.pending = source.slice(last); source = source.slice(0, last); }
    }
    const decoded = source.replace(/=\r?\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(decoded, 'latin1');
  }
}

/** The caller holds the mailbox lock. Partial FETCH bounds the wire buffer even
 * when BODYSTRUCTURE reports zero or a false size. Check one response at a time. */
export async function readImapAttachment(
  client: Pick<ImapFlow, 'fetchOne' | 'close'>,
  uid: number | string,
  part: string,
  encodingFor: (message: FetchMessageObject) => string,
  options: { maxBytes?: number; chunkSize?: number } = {},
): Promise<Buffer | null> {
  const limit = Math.min(options.maxBytes ?? ATTACHMENT_READ_BYTES, ATTACHMENT_READ_BYTES);
  const chunkSize = Math.min(options.chunkSize ?? 1024 * 1024, 1024 * 1024);
  if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new AttachmentReadLimitError();
  // Allow transfer-encoding expansion and short quoted-printable soft lines,
  // while still refusing an unbounded stream that only decodes to whitespace.
  const wireLimit = limit * 8 + chunkSize;
  let offset = 0; let decodedBytes = 0; let decoder: AttachmentTransferDecoder | undefined; let expired = false;
  const chunks: Buffer[] = [];
  const timer = setTimeout(() => { expired = true; client.close(); }, 45000);
  const retain = (buffer: Buffer) => {
    decodedBytes += buffer.length;
    if (decodedBytes > limit) throw new AttachmentReadLimitError();
    if (buffer.length) chunks.push(buffer);
  };
  try {
    for (;;) {
      if (expired) throw new AttachmentReadLimitError();
      const response = await client.fetchOne(uid, {
        uid: true, ...(offset === 0 ? { bodyStructure: true } : {}),
        bodyParts: [{ key: part, start: offset, maxLength: chunkSize }],
      }, { uid: true, binary: false });
      if (expired) throw new AttachmentReadLimitError();
      if (!response) {
        if (offset === 0) return null;
        throw new Error('Attachment disappeared during read');
      }
      if (String(response.uid) !== String(uid)) throw new Error('Attachment identity changed');
      const bytes = response.bodyParts?.get(part);
      if (!bytes) {
        if (offset === 0) return null;
        throw new Error('Incomplete attachment read');
      }
      if (bytes.length > chunkSize || offset + bytes.length > wireLimit) throw new AttachmentReadLimitError();
      decoder ??= new AttachmentTransferDecoder(response.binaryParts?.has(part) ? 'binary' : encodingFor(response));
      retain(decoder.push(bytes)); offset += bytes.length;
      if (bytes.length < chunkSize) { retain(decoder.push(Buffer.alloc(0), true)); return Buffer.concat(chunks, decodedBytes); }
    }
  } catch (error) { if (expired) throw new AttachmentReadLimitError(); throw error; }
  finally { clearTimeout(timer); }
}
