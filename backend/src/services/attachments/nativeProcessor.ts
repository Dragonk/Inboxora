import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AttachmentProcessingError, FILE_LIMIT, type ProcessingInput, type ProcessingOutput } from './processing.js';

/** No shell, temporary documents or inherited application secrets. The child is
 * owned directly by this request, so cancellation cannot orphan it in a worker. */
export function runNativeProcessor(input: ProcessingInput, signal: AbortSignal): Promise<ProcessingOutput> {
  signal.throwIfAborted();
  if (!['signatures', 'archive-index', 'archive-extract'].includes(input.action) || input.bytes.length > FILE_LIMIT) {
    return Promise.reject(new AttachmentProcessingError('INVALID_INPUT'));
  }
  const options = { action: input.action, entry: input.entry, filename: input.filename, remaining: input.remaining };
  const header = Buffer.from(JSON.stringify(options) + '\n');
  if (header.length > 8192) return Promise.reject(new AttachmentProcessingError('INVALID_INPUT'));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' };
  for (const key of ['PDF_SIGNATURE_TRUST_ROOTS', 'PDF_SIGNATURE_REVOCATION_DIR', 'PDF_SIGNATURE_ONLINE', 'PDF_SIGNATURE_EUTL', 'PDF_SIGNATURE_EUTL_CACHE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ATTACHMENT_PREVIEW_PYTHON || 'python3', ['-B', fileURLToPath(new URL('../../../preview/process.py', import.meta.url))], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let length = 0; let settled = false;
    const finish = (error?: Error, result?: ProcessingOutput) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (child.exitCode === null) child.kill('SIGKILL');
      chunks.length = 0;
      if (error) reject(error); else if (result) resolve(result); else reject(new AttachmentProcessingError('CORRUPT'));
    };
    const abort = () => finish(new AttachmentProcessingError('CANCELLED'));
    const timer = setTimeout(() => finish(new AttachmentProcessingError('LIMIT')), 28000);
    signal.addEventListener('abort', abort, { once: true });
    child.stderr.resume();
    child.once('error', () => finish(new AttachmentProcessingError('UNSUPPORTED')));
    child.stdin.on('error', () => { /* exit/error reports the child outcome; never log document bytes */ });
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > FILE_LIMIT + 4 * 1024 * 1024) finish(new AttachmentProcessingError('LIMIT'));
      else if (!settled) chunks.push(chunk);
    });
    child.once('close', (code, killedBy) => {
      if (settled) return;
      if (killedBy || code !== 0) return finish(new AttachmentProcessingError(killedBy ? 'LIMIT' : 'CORRUPT'));
      try {
        const output = Buffer.concat(chunks, length); const newline = output.indexOf(10);
        if (newline < 1 || newline > 4 * 1024 * 1024) throw new Error();
        const meta: unknown = JSON.parse(output.subarray(0, newline).toString());
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error();
        if ('error' in meta) {
          const allowed = ['LIMIT', 'CORRUPT', 'INVALID_INPUT', 'UNSUPPORTED', 'ENCRYPTED_ZIP'] as const;
          const code = allowed.find(value => value === meta.error);
          return finish(new AttachmentProcessingError(code || 'CORRUPT'));
        }
        if (!('byteLength' in meta) || !Number.isInteger(meta.byteLength) || meta.byteLength !== output.length - newline - 1) throw new Error();
        if (input.action === 'archive-extract') {
          return finish(undefined, { bytes: output.subarray(newline + 1), filename: 'filename' in meta && typeof meta.filename === 'string' ? meta.filename : 'attachment' });
        }
        if (!('json' in meta) || !meta.json || typeof meta.json !== 'object' || Array.isArray(meta.json)) throw new Error();
        finish(undefined, { json: meta.json as Record<string, unknown> });
      } catch { finish(new AttachmentProcessingError('CORRUPT')); }
    });
    child.stdin.write(header); child.stdin.end(input.bytes);
  });
}
