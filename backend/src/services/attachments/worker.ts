import { parentPort, workerData } from 'node:worker_threads';
import { AttachmentProcessingError, processAttachment, type ProcessingInput } from './processing.js';
const input = workerData as ProcessingInput;
try {
  const result = await processAttachment(input);
  if (result.json && JSON.stringify(result.json).length > 4 * 1024 * 1024) throw new AttachmentProcessingError('LIMIT');
  // Structured cloning copies bytes; no password or original input is returned.
  parentPort?.postMessage({ result });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof AttachmentProcessingError ? error.code : 'CORRUPT' });
} finally {
  input.bytes.fill(0); input.password = undefined;
  parentPort?.close();
}
