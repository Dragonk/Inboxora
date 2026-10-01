import { createServer, type AddressInfo, type Socket } from 'node:net';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { scanAttachment, scanConfiguration, AttachmentScanError } from './scan.js';

async function scanner(answer: string, run: (port: number, received: Buffer[]) => Promise<void>, premature = false) {
  const received: Buffer[] = []; const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    if (premature) { socket.end(answer + '\0'); return; }
    let bytes = Buffer.alloc(0); let command = false; const chunks: Buffer[] = [];
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (!command) {
        if (bytes.length < 10) return;
        expect(bytes.subarray(0, 10).toString()).toBe('zINSTREAM\0'); bytes = bytes.subarray(10); command = true;
      }
      while (bytes.length >= 4) {
        const size = bytes.readUInt32BE(); if (bytes.length < 4 + size) return;
        if (size === 0) { received.push(Buffer.concat(chunks)); socket.end(answer + '\0'); return; }
        expect(size).toBeLessThanOrEqual(65536); chunks.push(bytes.subarray(4, 4 + size)); bytes = bytes.subarray(4 + size);
      }
    });
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run((server.address() as AddressInfo).port, received); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
const bytes = Buffer.from('Synthetic scanner fixture'.repeat(5000));
describe('optional ClamAV protocol', () => {
  it('does not require a daemon unless configured', async () => {
    expect(scanConfiguration({})).toBeNull();
    expect(await scanAttachment(bytes, new AbortController().signal, null)).toBe('disabled');
    expect(() => scanConfiguration({ ATTACHMENT_CLAMAV_HOST: 'scanner', ATTACHMENT_CLAMAV_PORT: 'bad' })).toThrow(AttachmentScanError);
  });
  it('streams exact bytes, recognizes clean completion and keeps only a short digest cache', async () => scanner('stream: OK', async (port, received) => {
    const config = { host: '127.0.0.1', port, timeout: 1000 };
    const original = Buffer.from(bytes);
    expect(await scanAttachment(bytes, new AbortController().signal, config)).toBe('clean');
    expect(received).toEqual([bytes]); expect(bytes).toEqual(original);
    expect(await scanAttachment(bytes, new AbortController().signal, config)).toBe('clean');
    expect(received).toHaveLength(1);
  }));
  it.each([
    ['stream: Eicar-Signature FOUND', 'INFECTED'],
    ['stream: Heuristics.Limits.Exceeded FOUND', 'SCAN_LIMIT'],
    ['stream: Heuristics.Encrypted.PDF FOUND', 'SCAN_LIMIT'],
    ['INSTREAM size limit exceeded. ERROR', 'SCAN_LIMIT'],
    ['stream: cannot scan ERROR', 'SCAN_UNAVAILABLE'],
    ['arbitrary OK', 'SCAN_UNAVAILABLE'],
  ])('%s is not considered safe', async (answer, code) => scanner(answer, async port => {
    await expect(scanAttachment(bytes, new AbortController().signal, { host: '127.0.0.1', port, timeout: 1000 })).rejects.toMatchObject({ code });
  }));
  it('rejects a clean response before the whole file has been submitted', async () => scanner('stream: OK', async port => {
    await expect(scanAttachment(Buffer.alloc(8 * 1024 * 1024), new AbortController().signal, { host: '127.0.0.1', port, timeout: 1000 })).rejects.toMatchObject({ code: 'SCAN_UNAVAILABLE' });
  }, true));
  it('cancellation does not scan or retain source bytes', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(scanAttachment(bytes, controller.signal, null)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
