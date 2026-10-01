import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';

export type ScanStatus = 'clean' | 'disabled';
export class AttachmentScanError extends Error {
  constructor(public code: 'INFECTED' | 'SCAN_UNAVAILABLE' | 'SCAN_LIMIT') { super(code); }
}
export interface ScanConfig { host: string; port: number; timeout: number }
export function scanConfiguration(env: NodeJS.ProcessEnv = process.env): ScanConfig | null {
  if (!env.ATTACHMENT_CLAMAV_HOST) return null;
  const port = Number(env.ATTACHMENT_CLAMAV_PORT || 3310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AttachmentScanError('SCAN_UNAVAILABLE');
  return { host: env.ATTACHMENT_CLAMAV_HOST, port, timeout: 15000 };
}
const cleanCache = new Map<string, number>();
let active = 0;
/** Only a configured internal daemon receives bytes. No caller-supplied scanner address or file path. */
export async function scanAttachment(bytes: Uint8Array, signal: AbortSignal, config = scanConfiguration()): Promise<ScanStatus> {
  signal.throwIfAborted();
  if (!config) return 'disabled';
  if (bytes.length > 50 * 1024 * 1024) throw new AttachmentScanError('SCAN_LIMIT');
  const key = createHash('sha256').update(JSON.stringify([config.host, config.port])).update(bytes).digest('hex');
  if ((cleanCache.get(key) || 0) > Date.now()) return 'clean';
  if (active >= 2) throw new AttachmentScanError('SCAN_UNAVAILABLE');
  active++;
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: config.host, port: config.port });
      let response = ''; let settled = false; let submitted = false;
      const finish = (error?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); socket.destroy();
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
      const timer = setTimeout(() => finish(new AttachmentScanError('SCAN_UNAVAILABLE')), config.timeout);
      signal.addEventListener('abort', abort, { once: true });
      socket.on('error', () => finish(new AttachmentScanError('SCAN_UNAVAILABLE')));
      socket.on('close', () => { if (!settled) finish(new AttachmentScanError('SCAN_UNAVAILABLE')); });
      socket.on('data', chunk => {
        response += chunk.toString('utf8');
        if (response.length > 2048) return finish(new AttachmentScanError('SCAN_UNAVAILABLE'));
        if (!response.includes('\0')) return;
        const answer = response.slice(0, response.indexOf('\0'));
        if (answer === 'stream: OK') finish(submitted ? undefined : new AttachmentScanError('SCAN_UNAVAILABLE'));
        else if (/ FOUND$/.test(answer)) finish(new AttachmentScanError(/Heuristics\.(Limits|Encrypted)/.test(answer) ? 'SCAN_LIMIT' : 'INFECTED'));
        else finish(new AttachmentScanError(/limit exceeded/i.test(answer) ? 'SCAN_LIMIT' : 'SCAN_UNAVAILABLE'));
      });
      const write = (data: Uint8Array) => new Promise<void>((done, fail) => socket.write(data, error => error ? fail(error) : done()));
      socket.once('connect', () => {
        void (async () => {
          await write(Buffer.from('zINSTREAM\0'));
          for (let offset = 0; offset < bytes.length && !settled; offset += 65536) {
            signal.throwIfAborted(); const chunk = bytes.subarray(offset, offset + 65536);
            const length = Buffer.alloc(4); length.writeUInt32BE(chunk.length); await write(length); await write(chunk);
          }
          if (!settled) { submitted = true; await write(Buffer.alloc(4)); }
        })().catch(() => finish(new AttachmentScanError('SCAN_UNAVAILABLE')));
      });
    });
    signal.throwIfAborted();
    // Brief digest-only reuse avoids rescanning the same chip and preview concurrently.
    for (const [digest, expires] of cleanCache) if (expires < Date.now()) cleanCache.delete(digest);
    if (cleanCache.size >= 256) cleanCache.delete(cleanCache.keys().next().value!);
    cleanCache.set(key, Date.now() + 30000);
    return 'clean';
  } finally { active--; }
}

/** Ownership must have been checked before this helper. Download remains a separate, inert response. */
export async function approveAttachmentPreview(req: Request, res: Response, bytes: Uint8Array): Promise<boolean> {
  res.set('Cache-Control', 'private, no-store'); res.set('X-Content-Type-Options', 'nosniff');
  if (bytes.byteLength > 50 * 1024 * 1024) { res.status(413).json({ code: 'LIMIT' }); return false; }
  if (req.query.preview === undefined) return true;
  if (req.query.preview !== '1' || req.get('X-Requested-With') !== 'MailFlow') { res.status(403).json({ code: 'CSRF' }); return false; }
  const controller = new AbortController(); const abort = () => controller.abort();
  req.once('aborted', abort); res.once('close', abort);
  try { const status = await scanAttachment(bytes, controller.signal); res.set('X-Attachment-Scan', status); return true; }
  catch (error) {
    if (!res.destroyed) res.status(error instanceof AttachmentScanError && error.code === 'INFECTED' ? 422 : 503).json({ code: error instanceof AttachmentScanError ? error.code : 'SCAN_UNAVAILABLE' });
    return false;
  } finally { req.off('aborted', abort); res.off('close', abort); }
}
