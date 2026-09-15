import { decrypt, encrypt } from './encryption.js';
import { query } from './db.js';
import type { DbRow } from './db.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { validateHost } from './hostValidation.js';
import { safeFetch } from './safeFetch.js';
import { createRequestSignal, parseJson, readLimited, readSseData, sanitizeText } from './aiHttp.js';
import { completeCodexText, streamCodexResponses } from './openaiCodexResponses.js';
import { getCodexAccess, getCodexStatus } from './openaiCodexAuth.js';
import { toAppError } from '../utils/errors.js';

export const AI_PROVIDER_API_KEY = 'api-key';
export const AI_PROVIDER_CHATGPT = 'chatgpt';
export const MASKED_API_KEY = '••••••••';
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-luna';

const PROVIDERS = new Set([AI_PROVIDER_API_KEY, AI_PROVIDER_CHATGPT]);
const ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const JSON_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const SSE_EVENT_LIMIT_BYTES = 256 * 1024;
const OUTPUT_LIMIT_CHARS = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const defaultFetchFn = (...args: Parameters<typeof fetch>) => fetch(...args);

export interface AiProviderErrorOptions {
  status?: number;
  expose?: boolean;
}

export class AiProviderError extends Error {
  status: number;
  expose: boolean;

  // `expose` marks an error whose message is safe to show the caller (already
  // secret-redacted and sanitized) — provider-originated failures set it so the
  // admin sees the real reason instead of a generic message, even on a 5xx.
  constructor(message: string, { status = 503, expose = false }: AiProviderErrorOptions = {}) {
    super(message);
    this.name = 'AiProviderError';
    this.status = status;
    this.expose = expose;
  }
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBaseUrl(value: unknown): string {
  return cleanString(value).replace(/\/+$/, '');
}

export interface AiConfigInput {
  enabled?: boolean;
  provider?: string;
  apiKeyConfig?: { baseUrl?: string; apiKey?: string | null; model?: string };
  chatgptConfig?: { model?: string };
  features?: { compose?: boolean; summarize?: boolean };
  // Legacy flat shape still accepted from system_settings rows.
  baseUrl?: string;
  apiKey?: string | null;
  model?: string;
}

export function normalizeAiConfig(raw: AiConfigInput = {}) {
  const apiSource = raw.apiKeyConfig && typeof raw.apiKeyConfig === 'object' ? raw.apiKeyConfig : raw;
  const chatgptSource = raw.chatgptConfig && typeof raw.chatgptConfig === 'object'
    ? raw.chatgptConfig
    : {};
  const provider = typeof raw.provider === 'string' && PROVIDERS.has(raw.provider) ? raw.provider : AI_PROVIDER_API_KEY;
  return {
    enabled: raw.enabled !== false,
    provider,
    apiKeyConfig: {
      baseUrl: normalizeBaseUrl(apiSource.baseUrl),
      apiKey: apiSource.apiKey || null,
      model: cleanString(apiSource.model),
    },
    chatgptConfig: {
      model: cleanString(chatgptSource.model) || DEFAULT_CODEX_MODEL,
    },
    features: {
      compose: raw.features?.compose !== false,
      summarize: raw.features?.summarize !== false,
    },
  };
}

/** One chat message sent to a provider. */
type AiMessage = { role: string; content: string };

/** The fully normalised configuration the provider runs with. */
type NormalizedAiConfig = ReturnType<typeof normalizeAiConfig>;

function publicConfig(config: ReturnType<typeof normalizeAiConfig> | null | undefined) {
  if (!config) return null;
  return {
    ...config,
    apiKeyConfig: {
      ...config.apiKeyConfig,
      apiKey: config.apiKeyConfig.apiKey ? MASKED_API_KEY : '',
    },
  };
}

function redactSecrets(value: unknown, secrets: unknown[] = []): string {
  let redacted = String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}

function providerError(status: number, text: string, secrets: unknown[] = []) {
  const parsed = parseJson(text);
  const raw = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message;
  const detail = sanitizeText(redactSecrets(raw || text, secrets));
  return new AiProviderError(`AI provider error (${status})${detail ? `: ${detail}` : ''}`, { status: 502, expose: true });
}

function providerRequestError(error: unknown, request: { timedOut(): boolean; cleanup(): void }, callerSignal: AbortSignal | null | undefined) {
  if (request.timedOut()) return new AiProviderError('AI provider request timed out', { status: 504, expose: true });
  if (callerSignal?.aborted) return new AiProviderError('AI provider request was aborted', { status: 499, expose: true });
  if (error instanceof AiProviderError) return error;
  return new AiProviderError(
    `AI provider request failed: ${sanitizeText(toAppError(error).message) || 'network error'}`,
    { status: 502, expose: true },
  );
}

interface ProviderRequestOptions { signal?: AbortSignal; timeoutMs?: number }

async function openProviderRequest(fetchFn: typeof fetch, url: string, init: RequestInit, { signal, timeoutMs = DEFAULT_TIMEOUT_MS }: ProviderRequestOptions = {}) {
  const request = createRequestSignal(signal, timeoutMs, 'AI request timed out');
  try {
    const response = await fetchFn(url, { ...init, signal: request.signal });
    return { ...request, response };
  } catch (error) {
    request.cleanup();
    throw providerRequestError(error, request, signal);
  }
}

interface ParseSseOptions { signal?: AbortSignal; secrets?: unknown[] }

async function* parseChatCompletionsSse(response: Response, { signal, secrets }: ParseSseOptions = {}) {
  let outputChars = 0;
  let completed = false;
  const createError = (reason: string): AiProviderError => {
    if (reason === 'empty_body') return new AiProviderError('AI provider returned an empty stream', { status: 502 });
    if (reason === 'aborted') return new AiProviderError('AI provider request was aborted', { status: 499 });
    return new AiProviderError('AI provider stream event was too large', { status: 502 });
  };

  for await (const data of readSseData(response, {
    signal,
    maxEventBytes: SSE_EVENT_LIMIT_BYTES,
    createError,
  })) {
    if (data.trim() === '[DONE]') {
      completed = true;
      return;
    }
    const event = parseJson(data);
    if (!event) throw new AiProviderError('AI provider returned a malformed stream event', { status: 502 });
    if (event.error) throw providerError(502, JSON.stringify({ error: event.error }), secrets);
    const choice = event.choices?.[0];
    // OpenAI-compatible providers normally send [DONE], but finish_reason is also
    // an explicit terminal event. Do not mistake a bare transport EOF for either.
    if (typeof choice?.finish_reason === 'string' && choice.finish_reason) completed = true;
    const delta = choice?.delta?.content;
    if (typeof delta !== 'string' || !delta) continue;
    outputChars += delta.length;
    if (outputChars > OUTPUT_LIMIT_CHARS) throw new AiProviderError('AI provider output was too large', { status: 502 });
    yield delta;
  }
  if (!completed) throw new AiProviderError('AI provider stream ended without a completion marker', { status: 502, expose: true });
}

export function createAiProvider({
  queryFn = query,
  encryptFn = encrypt,
  decryptFn = decrypt,
  validateHostFn = validateHost,
  getConnectionPolicyFn = getConnectionPolicy,
  fetchFn = defaultFetchFn,
  getCodexAccessFn = getCodexAccess,
  getCodexStatusFn = getCodexStatus,
  streamCodexResponsesFn = streamCodexResponses,
  completeCodexTextFn = completeCodexText,
}: {
  queryFn?: (text: string, params?: unknown[]) => Promise<{ rows: DbRow[]; rowCount?: number }>;
  encryptFn?: typeof encrypt;
  decryptFn?: typeof decrypt;
  validateHostFn?: typeof validateHost;
  getConnectionPolicyFn?: typeof getConnectionPolicy;
  fetchFn?: (...args: Parameters<typeof fetch>) => Promise<Response>;
  getCodexAccessFn?: typeof getCodexAccess;
  getCodexStatusFn?: typeof getCodexStatus;
  streamCodexResponsesFn?: typeof streamCodexResponses;
  completeCodexTextFn?: typeof completeCodexText;
} = {}) {
  async function loadAiConfig() {
    const result = await queryFn("SELECT value FROM system_settings WHERE key = 'ai_config'");
    if (!result.rows.length) return null;
    const rawValue = result.rows[0]?.value;
    const parsed = typeof rawValue === 'string' ? parseJson(rawValue) : null;
    return parsed ? normalizeAiConfig(parsed) : null;
  }

  async function getAdminAiConfig() {
    return publicConfig(await loadAiConfig());
  }

  async function saveAiConfig(input: AiConfigInput = {}) {
    if (typeof input.provider !== 'string' || !PROVIDERS.has(input.provider)) throw new AiProviderError('Unknown AI provider', { status: 400 });
    if (input.enabled !== false && input.provider === AI_PROVIDER_CHATGPT
        && !cleanString(input.chatgptConfig?.model)) {
      throw new AiProviderError('ChatGPT model name is required', { status: 400 });
    }
    const existing = await loadAiConfig();
    const incomingApi = input.apiKeyConfig || {};
    const incomingKey = incomingApi.apiKey;
    const storedKey = typeof incomingKey === 'string' && incomingKey && incomingKey !== MASKED_API_KEY
      ? encryptFn(incomingKey)
      : (existing?.apiKeyConfig.apiKey || null);
    const config = normalizeAiConfig({
      ...input,
      apiKeyConfig: { ...incomingApi, apiKey: storedKey },
    });

    if (config.enabled && config.provider === AI_PROVIDER_API_KEY
        && (!config.apiKeyConfig.baseUrl || !config.apiKeyConfig.model)) {
      throw new AiProviderError('API base URL and model name are required', { status: 400 });
    }
    if (config.provider === AI_PROVIDER_API_KEY && config.apiKeyConfig.baseUrl) {
      let hostname;
      try {
        hostname = new URL(config.apiKeyConfig.baseUrl).hostname;
      } catch {
        throw new AiProviderError('Invalid API base URL', { status: 400 });
      }
      const policy = await getConnectionPolicyFn();
      const hostError = await validateHostFn(hostname, { allowPrivate: policy.allowPrivateHosts });
      if (hostError) throw new AiProviderError(`API base URL: ${hostError}`, { status: 400 });
    }

    await queryFn(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('ai_config', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(config)],
    );
    return publicConfig(config);
  }

  async function deleteAiConfig() {
    await queryFn("DELETE FROM system_settings WHERE key = 'ai_config'");
  }

  async function requireSelectedConfig() {
    const config = await loadAiConfig();
    if (!config) throw new AiProviderError('AI provider not configured');
    if (!config.enabled) throw new AiProviderError('AI features are disabled');
    if (config.provider === AI_PROVIDER_API_KEY
        && (!config.apiKeyConfig.baseUrl || !config.apiKeyConfig.model)) {
      throw new AiProviderError('AI provider not fully configured');
    }
    return config;
  }

  function apiKeyCredential(config: NormalizedAiConfig): string | null {
    return config.apiKeyConfig.apiKey ? decryptFn(config.apiKeyConfig.apiKey) : null;
  }

  function apiKeyHeaders(apiKey: string | null | undefined): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  }

  async function openApiKeyRequest(url: string, init: RequestInit, options: ProviderRequestOptions = {}) {
    const policy = await getConnectionPolicyFn();
    // Production AI calls use the pinned, redirect-aware connector. Keep an explicitly
    // injected fetch for isolated unit tests only.
    const requestFetch = fetchFn === defaultFetchFn
      ? (target: Parameters<typeof fetch>[0], requestInit?: RequestInit) => safeFetch(String(target), requestInit, { allowPrivate: policy.allowPrivateHosts })
      : fetchFn;
    return openProviderRequest(requestFetch, url, init, options);
  }

  interface CompleteOptions { signal?: AbortSignal; maxTokens?: number; allowEmpty?: boolean }

  async function completeApiKey(config: NormalizedAiConfig, messages: AiMessage[], { signal, maxTokens, allowEmpty = false }: CompleteOptions = {}) {
    const apiKey = apiKeyCredential(config);
    const body = {
      model: config.apiKeyConfig.model,
      messages,
      ...(Number.isFinite(maxTokens) ? { max_tokens: maxTokens } : {}),
      stream: false,
      think: false,
    };
    const request = await openApiKeyRequest(`${config.apiKeyConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: apiKeyHeaders(apiKey),
      body: JSON.stringify(body),
    }, { signal });
    try {
      const { response } = request;
      const text = await readLimited(response, response.ok ? JSON_BODY_LIMIT_BYTES : ERROR_BODY_LIMIT_BYTES);
      if (!response.ok) throw providerError(response.status, text, [apiKey]);
      const parsed = parseJson(text);
      const choice = parsed?.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content === 'string') return content;
      // A reasoning model — or any turn truncated by max_tokens — can return a
      // null `content`: the output went entirely to reasoning, or the budget was
      // spent before any text was emitted. That is a well-formed response, not a
      // transport failure. Callers that only need to confirm the endpoint works
      // (the connection test) accept it as empty; real completions surface the
      // finish reason instead of a generic error.
      if (choice && content == null) {
        if (allowEmpty) return '';
        const reason = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'unknown';
        throw new AiProviderError(
          `AI provider returned an empty completion (finish_reason: ${reason})`,
          { status: 502, expose: true },
        );
      }
      throw new AiProviderError('AI provider returned an invalid completion', { status: 502, expose: true });
    } catch (error) {
      throw providerRequestError(error, request, signal);
    } finally {
      request.cleanup();
    }
  }

  async function* streamApiKey(config: NormalizedAiConfig, messages: AiMessage[], { signal }: { signal?: AbortSignal } = {}) {
    const apiKey = apiKeyCredential(config);
    const request = await openApiKeyRequest(`${config.apiKeyConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: apiKeyHeaders(apiKey),
      body: JSON.stringify({ model: config.apiKeyConfig.model, messages, stream: true }),
    }, { signal, timeoutMs: 120_000 });
    try {
      const { response } = request;
      if (!response.ok) {
        const text = await readLimited(response, ERROR_BODY_LIMIT_BYTES);
        throw providerError(response.status, text, [apiKey]);
      }
      yield* parseChatCompletionsSse(response, { signal: request.signal, secrets: [apiKey] });
    } catch (error) {
      throw providerRequestError(error, request, signal);
    } finally {
      request.cleanup();
    }
  }

  function codexRequest(config: NormalizedAiConfig, messages: AiMessage[], options: CompleteOptions, credentials: Awaited<ReturnType<typeof getCodexAccess>>) {
    return {
      ...credentials,
      model: config.chatgptConfig.model,
      messages,
      signal: options.signal,
    };
  }

  async function completeText(messages: AiMessage[], options: CompleteOptions = {}) {
    const config = await requireSelectedConfig();
    if (config.provider === AI_PROVIDER_API_KEY) return completeApiKey(config, messages, options);
    let credentials = await getCodexAccessFn();
    try {
      return await completeCodexTextFn(codexRequest(config, messages, options, credentials));
    } catch (error) {
      if (toAppError(error).status !== 401) throw error;
      credentials = await getCodexAccessFn({ forceRefresh: true });
      return completeCodexTextFn(codexRequest(config, messages, options, credentials));
    }
  }

  async function* streamChat(messages: AiMessage[], options: Record<string, unknown> = {}) {
    const config = await requireSelectedConfig();
    if (config.provider === AI_PROVIDER_API_KEY) {
      yield* streamApiKey(config, messages, options);
      return;
    }

    let forceRefresh = false;
    for (;;) {
      const credentials = forceRefresh
        ? await getCodexAccessFn({ forceRefresh: true })
        : await getCodexAccessFn();
      let emitted = false;
      try {
        for await (const delta of streamCodexResponsesFn(codexRequest(config, messages, options, credentials))) {
          emitted = true;
          yield delta;
        }
        return;
      } catch (error) {
        if (forceRefresh || emitted || toAppError(error).status !== 401) throw error;
        forceRefresh = true;
      }
    }
  }

  interface AiProviderStatusFeatures { compose: boolean; summarize: boolean }

  interface AiProviderStatus {
    enabled: boolean;
    provider: string;
    features: Partial<AiProviderStatusFeatures>;
    reconnectRequired: boolean;
    connection?: {
      connected?: boolean;
      reconnectRequired?: boolean;
      [key: string]: unknown;
    };
  }

  async function getAiStatus(): Promise<AiProviderStatus> {
    const config = await loadAiConfig();
    if (!config || !config.enabled) {
      return {
        enabled: false,
        provider: config?.provider || AI_PROVIDER_API_KEY,
        features: config?.features || {},
        reconnectRequired: false,
      };
    }
    if (config.provider === AI_PROVIDER_API_KEY) {
      const enabled = Boolean(config.apiKeyConfig.baseUrl && config.apiKeyConfig.model);
      return { enabled, provider: config.provider, features: config.features, reconnectRequired: false };
    }
    const connection = await getCodexStatusFn();
    return {
      enabled: connection.connected === true && Boolean(config.chatgptConfig.model),
      provider: config.provider,
      features: config.features,
      reconnectRequired: connection.reconnectRequired === true,
      connection,
    };
  }

  async function testAiProvider() {
    // The connection test only needs to prove the endpoint is reachable, the key
    // is accepted, and the model returns a well-formed completion. `allowEmpty`
    // keeps it from failing on reasoning models that spend the small token budget
    // on reasoning and return empty content (see completeApiKey).
    await completeText(
      [{ role: 'user', content: 'Reply with only the word "ok".' }],
      { maxTokens: 16, allowEmpty: true },
    );
    return { ok: true };
  }

  return {
    loadAiConfig,
    getAdminAiConfig,
    saveAiConfig,
    deleteAiConfig,
    getAiStatus,
    testAiProvider,
    streamChat,
    completeText,
  };
}

const defaultProvider = createAiProvider();

export const loadAiConfig = defaultProvider.loadAiConfig;
export const getAdminAiConfig = defaultProvider.getAdminAiConfig;
export const saveAiConfig = defaultProvider.saveAiConfig;
export const deleteAiConfig = defaultProvider.deleteAiConfig;
export const getAiStatus = defaultProvider.getAiStatus;
export const testAiProvider = defaultProvider.testAiProvider;
export const streamChat = defaultProvider.streamChat;
export const completeText = defaultProvider.completeText;
