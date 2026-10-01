import { runNativeProcessor } from './nativeProcessor.js';
import { Worker } from 'node:worker_threads';
import { AttachmentProcessingError, type ProcessingInput, type ProcessingOutput } from './processing.js';
const source = import.meta.url.endsWith('.ts');
/** Never fall back to unbounded main-thread parsing on a worker failure. */
export function runAttachmentWorker(input: ProcessingInput, signal: AbortSignal): Promise<ProcessingOutput> {
  signal.throwIfAborted();
  if (['signatures', 'archive-index', 'archive-extract'].includes(input.action)) return runNativeProcessor(input, signal);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(source ? './worker.ts' : './worker.js', import.meta.url), {
      workerData: input, execArgv: source ? ['--import', 'tsx'] : [],
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      name: 'attachment-preview', stdout: true, stderr: true,
    });
    // Consume library diagnostics without retaining document data or forwarding it to server logs.
    worker.stdout?.resume(); worker.stderr?.resume();
    let settled = false;
    const finish = (error?: Error, value?: ProcessingOutput) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error); else if (value) resolve(value); else reject(new AttachmentProcessingError('CORRUPT'));
    };
    const abort = () => finish(new AttachmentProcessingError('CANCELLED'));
    const timer = setTimeout(() => finish(new AttachmentProcessingError('LIMIT')), 15000);
    signal.addEventListener('abort', abort, { once: true });
    worker.once('error', (error: Error & { code?: string }) => finish(new AttachmentProcessingError(
      error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'LIMIT' : 'CORRUPT',
    )));
    worker.once('exit', () => { if (!settled) finish(new AttachmentProcessingError('CORRUPT')); });
    worker.once('message', (message: { result?: ProcessingOutput; error?: AttachmentProcessingError['code'] }) => {
      finish(message.error ? new AttachmentProcessingError(message.error) : undefined, message.result);
    });
  });
}
