import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImapFlow } from 'imapflow';
import { AttachmentByteBudget, AttachmentReadLimitError, AttachmentTransferDecoder, readImapAttachment } from './attachmentRead.js';

function fake(wire: Buffer, uid = 42) {
  const fetchOne = vi.fn<ImapFlow['fetchOne']>(async (_uid, query, options) => {
    expect(options).toEqual({ uid: true, binary: false });
    const part = query.bodyParts?.[0];
    if (!part || typeof part === 'string') throw new Error('Expected a bounded partial FETCH');
    expect(part.maxLength).toBeLessThanOrEqual(1024 * 1024);
    return { seq: 1, uid, size: 0, bodyParts: new Map([[part.key, wire.subarray(part.start, part.start! + part.maxLength!)]]) };
  });
  return { fetchOne, close: vi.fn() };
}
afterEach(() => vi.useRealTimers());
describe('bounded IMAP reads preserve original attachment bytes', () => {
  it.each(['base64','quoted-printable','8bit','binary'])('preserves %s, including Polish legacy bytes, across partial reads', async encoding => {
    const original = Buffer.from([65, 0, 0xb3, 0xf3, 0xbf, 10, 13, 255, 90]);
    const wire = encoding === 'base64' ? Buffer.from(original.toString('base64').replace(/(.{4})/g, '$1\r\n'))
      : encoding === 'quoted-printable' ? Buffer.from([...original].map(byte => '=' + byte.toString(16).padStart(2, '0')).join('=\r\n')) : original;
    for (const chunkSize of [1,2,3,4,7,8,16]) {
      const client = fake(wire);
      const decoded = await readImapAttachment(client, 42, '2', () => encoding, { maxBytes: original.length, chunkSize });
      expect(decoded, `${encoding}/${chunkSize}`).toEqual(original);
      expect(client.fetchOne.mock.calls.every(call => call[1].bodyParts?.[0] && typeof call[1].bodyParts[0] !== 'string')).toBe(true);
    }
  });
  it('stops when actual decoded bytes exceed the limit even with unknown metadata', async () => {
    const client = fake(Buffer.from('1234567890'));
    await expect(readImapAttachment(client, 42, '2', () => 'binary', { maxBytes: 5, chunkSize: 2 })).rejects.toBeInstanceOf(AttachmentReadLimitError);
    expect(client.fetchOne).toHaveBeenCalledTimes(3);
  });
  it('caps whitespace-only transfer-encoded input separately from decoded output', async () => {
    const client = fake(Buffer.from(' '.repeat(100)));
    await expect(readImapAttachment(client, 42, '2', () => 'base64', { maxBytes: 1, chunkSize: 4 })).rejects.toBeInstanceOf(AttachmentReadLimitError);
    expect(client.fetchOne).toHaveBeenCalledTimes(4);
  });
  it('rejects ignored partial ranges, changed UIDs and disappearing attachments', async () => {
    const client = fake(Buffer.from('12345678'));
    client.fetchOne.mockResolvedValueOnce({ seq: 1, uid: 42, bodyParts: new Map([['2', Buffer.alloc(9)]]) });
    await expect(readImapAttachment(client, 42, '2', () => 'binary', { chunkSize: 8 })).rejects.toBeInstanceOf(AttachmentReadLimitError);
    await expect(readImapAttachment(fake(Buffer.from('123'), 43), 42, '2', () => 'binary')).rejects.toThrow('identity');
    const missing = fake(Buffer.from('123456'));
    missing.fetchOne.mockImplementationOnce(async () => ({ seq: 1, uid: 42, bodyParts: new Map([['2', Buffer.from('12')]]) })).mockResolvedValueOnce(false);
    await expect(readImapAttachment(missing, 42, '2', () => 'binary', { chunkSize: 2 })).rejects.toThrow('disappeared');
  });
  it('does not decode BINARY response bytes twice', async () => {
    const client = fake(Buffer.from('TQ=='));
    client.fetchOne.mockResolvedValueOnce({ seq: 1, uid: 42, binaryParts: new Set(['2']), bodyParts: new Map([['2', Buffer.from('TQ==')]]) });
    expect(await readImapAttachment(client, 42, '2', () => 'base64')).toEqual(Buffer.from('TQ=='));
  });
  it('allows an empty file and returns null only when the first part is absent', async () => {
    expect(await readImapAttachment(fake(Buffer.alloc(0)), 42, '2', () => 'binary')).toEqual(Buffer.alloc(0));
    const client = fake(Buffer.alloc(0)); client.fetchOne.mockResolvedValueOnce(false);
    expect(await readImapAttachment(client, 42, '2', () => 'binary')).toBeNull();
  });
  it('closes a stalled provider read and does not retain a timed-out result', async () => {
    vi.useFakeTimers();
    let rejectFetch: (error: Error) => void = () => {};
    const client = fake(Buffer.alloc(0));
    client.fetchOne.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFetch = reject; }));
    client.close.mockImplementationOnce(() => rejectFetch(new Error('Connection closed')));
    const operation = readImapAttachment(client, 42, '2', () => 'binary');
    const assertion = expect(operation).rejects.toBeInstanceOf(AttachmentReadLimitError);
    await vi.advanceTimersByTimeAsync(45000); await assertion;
    expect(client.close).toHaveBeenCalledTimes(1);
  });
  it('refuses corrupt base64 rather than returning a silently shortened file', () => {
    expect(() => new AttachmentTransferDecoder('base64').push(Buffer.from('bad!'), true)).toThrow('encoding');
    expect(() => new AttachmentTransferDecoder('base64').push(Buffer.from('A'), true)).toThrow('encoding');
    const decoder = new AttachmentTransferDecoder('base64'); decoder.push(Buffer.from('TQ=='));
    expect(() => decoder.push(Buffer.from('TQ=='))).toThrow('encoding');
  });
});
describe('aggregate attachment budget', () => {
  it('refuses the first excess byte before retaining another provider buffer', () => {
    const budget = new AttachmentByteBudget(10);
    budget.consume(4); budget.consume(6); expect(budget.remaining).toBe(0);
    budget.consume(0);
    expect(() => budget.consume(1)).toThrow(AttachmentReadLimitError);
    expect(budget.remaining).toBe(0);
  });
});

it('reads unchanged bytes over real ImapFlow partial FETCH, including an empty final literal', async () => {
  const { ImapFlow } = await import('imapflow');
  const { createServer } = await import('node:net');
  const original = Buffer.from([0, 255, 0xb3, 13, 10, 65]);
  const wire = Buffer.from(original.toString('base64'));
  const ranges: Array<[number, number]> = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.write('* OK [CAPABILITY IMAP4rev1] Fixture ready\r\n');
    let incoming = '';
    socket.on('data', bytes => {
      incoming += bytes.toString();
      while (incoming.includes('\r\n')) {
        const end = incoming.indexOf('\r\n'); const line = incoming.slice(0, end); incoming = incoming.slice(end + 2);
        const tag = line.split(' ')[0];
        const ok = () => socket.write(`${tag} OK Completed\r\n`);
        if (/ CAPABILITY$/.test(line)) { socket.write('* CAPABILITY IMAP4rev1\r\n'); ok(); }
        else if (/ LOGIN /.test(line)) ok();
        else if (/ LIST /.test(line)) { socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n'); ok(); }
        else if (/ SELECT /.test(line)) { socket.write('* 1 EXISTS\r\n* FLAGS (\\Seen)\r\n* OK [UIDVALIDITY 1] valid\r\n* OK [UIDNEXT 43] next\r\n'); ok(); }
        else if (/ UID FETCH /.test(line)) {
          const range = /BODY\.PEEK\[2\]<(\d+)\.(\d+)>/.exec(line);
          if (!range) { socket.write(`${tag} BAD Expected partial range\r\n`); continue; }
          const start = Number(range[1]); const length = Number(range[2]); ranges.push([start, length]);
          const data = wire.subarray(start, start + length);
          socket.write(`* 1 FETCH (UID 42 BODY[2]<${start}> {${data.length}}\r\n`);
          socket.write(data); socket.write(')\r\n'); ok();
        } else if (/ LOGOUT$/.test(line)) { socket.write('* BYE Closing\r\n'); ok(); socket.end(); }
        else socket.write(`${tag} BAD Unexpected fixture command\r\n`);
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const client = new ImapFlow({ host: '127.0.0.1', port: address.port, secure: false, doSTARTTLS: false,
    auth: { user: 'fixture', pass: 'fixture', loginMethod: 'LOGIN' }, logger: false, disableAutoIdle: true });
  try {
    await client.connect(); const lock = await client.getMailboxLock('INBOX');
    try { expect(await readImapAttachment(client, 42, '2', () => 'base64', { maxBytes: 6, chunkSize: 4 })).toEqual(original); }
    finally { lock.release(); }
    expect(ranges).toEqual([[0,4],[4,4],[8,4]]);
    await client.logout();
  } finally { client.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
