// Behavioral reference: pi-mono's MIT-licensed OpenAI Codex Responses adapter
// (packages/ai/src/api/openai-codex-responses.ts). This Mailflow-specific
// implementation keeps only the text/SSE surface needed by the existing AI UI.

import { createRequestSignal, readLimited, readSseData, sanitizeText } from './aiHttp.js';

export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

const DEFAULT_TIMEOUT_MS = 120_000;
const ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const EVENT_LIMIT_BYTES = 256 * 1024;
const OUTPUT_LIMIT_CHARS = 2 * 1024 * 1024;
const MAILFLOW_INSTRUCTIONS = 'You are Inboxora, a helpful email assistant.';

export class CodexResponseError extends Error {
  constructor(message: string, { status, code }: { status?: number; code?: string } = {}) {
    super(message);
    this.name = 'CodexResponseError';
    this.status = status;
    this.code = code;
  }
}

/** A single message as received from an untrusted caller before validation. */
interface CodexMessageInput {
  role?: unknown;
  content?: unknown;
}

/** The untrusted request body accepted by [buildCodexRequest]. */
export interface CodexRequestInput {
  model: unknown;
  messages: CodexMessageInput[];
}

function asRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function messageItem(role: unknown, content: unknown) {
  if (typeof content !== 'string') throw new Error('Each message content must be a string');
  if (typeof role !== 'string' || !['system', 'user', 'assistant'].includes(role)) {
    throw new Error(`Unsupported message role: ${role}`);
  }
  if (role === 'system') {
    return { type: 'message', role: 'developer', content: [{ type: 'input_text', text: content }] };
  }
  if (role === 'assistant') {
    return { type: 'message', role, content: [{ type: 'output_text', text: content }] };
  }
  return { type: 'message', role, content: [{ type: 'input_text', text: content }] };
}

export function buildCodexRequest({ model, messages }: CodexRequestInput) {
  if (typeof model !== 'string' || !model.trim()) throw new Error('ChatGPT model is required');
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages array is required');
  return {
    model: model.trim(),
    instructions: MAILFLOW_INSTRUCTIONS,
    input: messages.map((message) => messageItem(message?.role, message?.content)),
    store: false,
    stream: true,
  };
}

function upstreamErrorMessage(status: number, bodyText: string) {
  let detail: unknown;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const parsedRecord = asRecord(parsed) ? parsed : null;
    const error = parsedRecord?.error;
    const errorRecord = asRecord(error) ? error : null;
    detail = typeof error === 'string' ? error : errorRecord?.message;
  } catch {
    detail = bodyText;
  }
  const safe = sanitizeText(detail);
  return `ChatGPT provider error (${status})${safe ? `: ${safe}` : ''}`;
}

interface CodexSseEvent {
  type?: string;
  delta?: unknown;
  message?: unknown;
  code?: unknown;
  error?: unknown;
  response?: unknown;
}

function eventError(event: CodexSseEvent, fallback: string) {
  const nestedValue = event?.error;
  const nested = asRecord(nestedValue) ? nestedValue : null;
  const responseValue = event?.response;
  const responseRecord = asRecord(responseValue) ? responseValue : null;
  const responseErrorValue = responseRecord?.error;
  const responseError = asRecord(responseErrorValue) ? responseErrorValue : null;
  const raw = event?.message || nested?.message || responseError?.message;
  const message = sanitizeText(raw);
  const code = sanitizeText(event?.code || nested?.code || responseError?.code, 100);
  return new CodexResponseError(message ? `${fallback}: ${message}` : fallback, { code: code || undefined });
}

function parseEventData(data: string): CodexSseEvent {
  if (data.trim() === '[DONE]') return { type: 'done' };
  try {
    return JSON.parse(data);
  } catch {
    throw new CodexResponseError('Malformed ChatGPT response event');
  }
}

export async function* parseCodexSse(response: Response, { signal }: { signal?: AbortSignal } = {}) {
  let outputChars = 0;
  let terminal = false;
  const createError = (reason: string) => {
    if (reason === 'empty_body') return new CodexResponseError('ChatGPT response body was empty');
    if (reason === 'aborted') return new CodexResponseError('ChatGPT request was aborted');
    return new CodexResponseError('ChatGPT response event was too large');
  };

  for await (const data of readSseData(response, {
    signal,
    maxEventBytes: EVENT_LIMIT_BYTES,
    createError,
  })) {
    const parsed = parseEventData(data);
    if (parsed.type === 'done' || parsed.type === 'response.completed') {
      terminal = true;
      break;
    }
    if (parsed.type === 'response.output_text.delta') {
      const delta = typeof parsed.delta === 'string' ? parsed.delta : '';
      outputChars += delta.length;
      if (outputChars > OUTPUT_LIMIT_CHARS) {
        throw new CodexResponseError('ChatGPT response output was too large');
      }
      if (delta) yield delta;
      continue;
    }
    if (parsed.type === 'response.failed') throw eventError(parsed, 'ChatGPT response failed');
    if (parsed.type === 'response.incomplete') throw eventError(parsed, 'ChatGPT response was incomplete');
    if (parsed.type === 'error') throw eventError(parsed, 'ChatGPT stream error');
  }

  if (!terminal) throw new CodexResponseError('ChatGPT response ended before completion');
}

export interface StreamCodexOptions {
  accessToken: string;
  accountId: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function* streamCodexResponses({
  accessToken,
  accountId,
  model,
  messages,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: StreamCodexOptions) {
  if (typeof accessToken !== 'string' || !accessToken) throw new CodexResponseError('ChatGPT is not connected');
  if (typeof accountId !== 'string' || !accountId) throw new CodexResponseError('ChatGPT account is unavailable');
  const request = buildCodexRequest({ model, messages });
  const fetchSignal = createRequestSignal(signal, timeoutMs, `ChatGPT request timed out after ${timeoutMs}ms`);
  try {
    const response = await fetch(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'chatgpt-account-id': accountId,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'mailflow',
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: fetchSignal.signal,
    });

    if (!response.ok) {
      const body = await readLimited(response, ERROR_BODY_LIMIT_BYTES);
      throw new CodexResponseError(upstreamErrorMessage(response.status, body), { status: response.status });
    }
    yield* parseCodexSse(response, { signal: fetchSignal.signal });
  } catch (error) {
    if (fetchSignal.timedOut()) {
      throw new CodexResponseError(`ChatGPT request timed out after ${timeoutMs}ms`);
    }
    if (signal?.aborted) throw new CodexResponseError('ChatGPT request was aborted');
    if (error instanceof CodexResponseError) throw error;
    const errorRecord = asRecord(error) ? error : null;
    throw new CodexResponseError(`ChatGPT request failed: ${sanitizeText(errorRecord?.message) || 'network error'}`);
  } finally {
    fetchSignal.cleanup();
  }
}

export async function completeCodexText(options: StreamCodexOptions) {
  let text = '';
  for await (const delta of streamCodexResponses(options)) text += delta;
  return text;
}
