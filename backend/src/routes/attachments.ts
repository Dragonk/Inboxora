import { scanAttachment, AttachmentScanError } from '../services/attachments/scan.js';
import { Router, type Request, type Response } from 'express';
import busboy from 'busboy';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { requireAuth } from '../middleware/auth.js';
import { redisClient } from '../services/redis.js';
import { attachmentDisposition } from '../utils/contentDisposition.js';
import { runAttachmentWorker } from '../services/attachments/pool.js';
import { AttachmentProcessingError, FILE_LIMIT, type ProcessingAction, type ProcessingInput, type ProcessingOutput } from '../services/attachments/processing.js';

const userLimiter = new RateLimiterRedis({ storeClient: redisClient, useRedisPackage: true, keyPrefix: 'attachment-preview-user', points: 30, duration: 60 });
const passwordLimiter = new RateLimiterRedis({ storeClient: redisClient, useRedisPackage: true, keyPrefix: 'attachment-preview-password', points: 10, duration: 60 });
const ipLimiter = new RateLimiterRedis({ storeClient: redisClient, useRedisPackage: true, keyPrefix: 'attachment-preview-ip', points: 60, duration: 60 });
const actions = new Set<ProcessingAction>(['probe', 'unlock', 'eml-parse', 'eml-part', 'cards', 'scan', 'signatures', 'archive-index', 'archive-extract']);
interface Dependencies { admit: (userId: string, ip: string, action: ProcessingAction) => Promise<void>; process: (input: ProcessingInput, signal: AbortSignal) => Promise<ProcessingOutput> }
async function admit(userId: string, ip: string, action: ProcessingAction): Promise<void> {
  await userLimiter.consume(userId); await ipLimiter.consume(ip);
  if (action === 'unlock') await passwordLimiter.consume(userId);
}
/** Bounded multipart parsing happens only after session, CSRF and resource admission. */
export async function readProcessingInput(req: Request, action: ProcessingAction, signal: AbortSignal): Promise<ProcessingInput> {
  signal.throwIfAborted();
  if (Number(req.headers['content-length'] || 0) > FILE_LIMIT + 16384) throw new AttachmentProcessingError('LIMIT');
  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof busboy>;
    try { parser = busboy({ headers: req.headers, limits: { fileSize: FILE_LIMIT, files: 1, fields: 6, fieldSize: 1024, parts: 7, headerPairs: 100 } }); }
    catch { reject(new AttachmentProcessingError('INVALID_INPUT')); return; }
    const fields = new Map<string, string>(); const chunks: Buffer[] = []; let size = 0; let files = 0; let failed = false;
    const fail = (code: AttachmentProcessingError['code']) => {
      if (failed) return; failed = true; req.unpipe(parser); parser.destroy(); chunks.length = 0; cleanup(); reject(new AttachmentProcessingError(code));
    };
    const abort = () => fail('CANCELLED');
    let received = 0;
    const countBytes = (chunk: Buffer) => { received += chunk.length; if (received > FILE_LIMIT + 16384) fail('LIMIT'); };
    const cleanup = () => { signal.removeEventListener('abort', abort); req.off('data', countBytes); };
    req.on('data', countBytes);
    signal.addEventListener('abort', abort, { once: true });
    parser.on('file', (name, stream) => {
      files++;
      if (name !== 'file' || files !== 1) { stream.resume(); fail('INVALID_INPUT'); return; }
      stream.on('limit', () => fail('LIMIT'));
      stream.on('error', () => fail('CORRUPT'));
      stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > FILE_LIMIT) fail('LIMIT'); else if (!failed) chunks.push(chunk); });
    });
    parser.on('field', (name, value, info) => {
      if (info.valueTruncated || !['password', 'index', 'kind', 'entry', 'filename', 'remaining'].includes(name) || fields.has(name)) { fail('INVALID_INPUT'); return; }
      fields.set(name, value);
    });
    parser.on('filesLimit', () => fail('LIMIT')); parser.on('fieldsLimit', () => fail('LIMIT')); parser.on('partsLimit', () => fail('LIMIT'));
    parser.on('error', () => fail('CORRUPT'));
    parser.on('close', () => {
      cleanup(); if (failed) return;
      if (files !== 1 || !size || (fields.get('password')?.length || 0) > 256) { reject(new AttachmentProcessingError('INVALID_INPUT')); return; }
      const rawIndex = fields.get('index');
      if (rawIndex !== undefined && !/^(?:0|[1-9]\d{0,2})$/.test(rawIndex)) { reject(new AttachmentProcessingError('INVALID_INPUT')); return; }
      const index = rawIndex === undefined ? undefined : Number(rawIndex);
      resolve({ action, bytes: Buffer.concat(chunks, size), password: fields.get('password'), kind: fields.get('kind'), entry: fields.get('entry'), filename: fields.get('filename'), remaining: fields.has('remaining') ? Number(fields.get('remaining')) : undefined, index });
    });
    req.pipe(parser);
  });
}
export function createAttachmentRouter(dependencies: Dependencies = { admit, process: runAttachmentWorker }): Router {
  const router = Router(); let active = 0; const users = new Set<string>();
  router.post('/attachments/process/:action', requireAuth, async (req: Request, res: Response) => {
    const action = req.params.action as ProcessingAction;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.get('X-Requested-With') !== 'MailFlow') return void res.status(403).json({ code: 'CSRF' });
    if (!actions.has(action)) return void res.status(404).json({ code: 'UNSUPPORTED' });
    const userId = req.session.userId!;
    if (active >= 2 || users.has(userId)) return void res.status(429).json({ code: 'RATE_LIMIT' });
    // Reserve a slot before the first await, so slow uploads cannot oversubscribe memory.
    active++; users.add(userId);
    const controller = new AbortController(); const abort = () => controller.abort();
    req.once('aborted', abort); res.once('close', abort);
    const timer = setTimeout(abort, 30000); let input: ProcessingInput | undefined;
    try {
      try { await dependencies.admit(userId, req.ip || 'unknown', action); }
      catch (error) {
        const throttled = error !== null && typeof error === 'object' && 'msBeforeNext' in error;
        if (throttled) res.setHeader('Retry-After', '60');
        res.status(throttled ? 429 : 503).json({ code: throttled ? 'RATE_LIMIT' : 'UNAVAILABLE' }); return;
      }
      controller.signal.throwIfAborted();
      input = await readProcessingInput(req, action, controller.signal);
      const scan = await scanAttachment(input.bytes, controller.signal);
      if (action === 'scan') { res.json({ scan }); return; }
      const result = await dependencies.process(input, controller.signal); controller.signal.throwIfAborted();
      if (result.bytes) {
        if (result.bytes.byteLength > FILE_LIMIT) throw new AttachmentProcessingError('LIMIT');
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', attachmentDisposition(result.filename || 'attachment'));
        res.send(Buffer.from(result.bytes));
      } else res.json(result.json || {});
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        const code = error instanceof AttachmentScanError ? error.code : error instanceof AttachmentProcessingError ? error.code : controller.signal.aborted ? 'CANCELLED' : 'CORRUPT';
        res.status(code === 'LIMIT' ? 413 : code === 'UNSUPPORTED' ? 415 : code === 'WRONG_PASSWORD' || code === 'INFECTED' ? 422 : code === 'SCAN_UNAVAILABLE' || code === 'SCAN_LIMIT' ? 503 : 400).json({ code });
      }
    } finally {
      input?.bytes.fill(0); if (input) input.password = undefined;
      clearTimeout(timer); req.off('aborted', abort); res.off('close', abort); controller.abort(); active--; users.delete(userId);
    }
  });
  return router;
}
export default createAttachmentRouter();
