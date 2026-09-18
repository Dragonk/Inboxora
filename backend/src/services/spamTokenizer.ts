// Tokenizer and feature extractor for the antispam classifier.
//
// Pure functions: no I/O, no DB. Converts an email into the bag-of-words
// token list plus the binary/continuous flag features consumed by the
// multinomial Naive Bayes model and persisted at mark time
// (spam_training_log.token_counts / flag_features).
//
// Adapted from upstream MailFlow v0.2 for Inboxora (strict TypeScript,
// htmlparser2 reused from messageParser.js — already a backend dependency).

import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';
import { parseAuthResults } from './spamParser.js';
import { STOP_WORDS, STOP_WORDS_DEFAULT } from './spamStopWords.js';

export interface SpamAttachment {
  filename?: string | null;
  name?: string | null;
  contentType?: string | null;
  type?: string | null;
  [key: string]: unknown;
}

export interface SpamMessageInput {
  subject?: string | null;
  body?: string | null;
  bodyHtml?: string | null;
  from?: string | null;
  replyTo?: string | null;
  headers?: ReadonlyArray<string> | Record<string, string | ReadonlyArray<string> | undefined> | null;
  attachments?: ReadonlyArray<SpamAttachment> | null;
  [key: string]: unknown;
}

export interface FlagFeatures {
  dkim_pass: 1 | 0 | null;
  spf_pass: 1 | 0 | null;
  dmarc_pass: 1 | 0 | null;
  has_attachment: 1 | 0;
  attachment_is_executable: 1 | 0;
  all_caps_subject_ratio: number;
  from_equals_reply_to_mismatch: 1 | 0;
  [key: string]: 1 | 0 | number | null;
}

// File extensions associated with executable code. Shared with the rules
// engine (ATTACHMENT_EXECUTABLE / ATTACHMENT_DOUBLE_EXT) and intentionally a
// superset of the download-warning list (which is UX, this is a signal).
export const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'exe', 'scr', 'msi', 'com', 'cpl', 'hta', 'pif', 'gadget',
  'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1', 'bat', 'cmd',
  'docm', 'xlsm', 'pptm', 'dotm', 'xlsb', 'xlam',
  'jar', 'jnlp', 'class',
  'sh', 'bash', 'ksh', 'csh', 'zsh', 'command',
  'app', 'dmg', 'pkg', 'apk',
  'pyc', 'pyo', 'rb', 'pl',
]);

const ALL_STOP_WORDS: ReadonlySet<string> = new Set([
  ...STOP_WORDS_DEFAULT,
  ...Object.values(STOP_WORDS).flatMap(set => [...set]),
]);

const WORD_RE = /[\p{L}\p{N}_]+/gu;
const CJK_RE = /[㐀-䶿一-鿿]/u;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

export const MAX_BODY_CHARS = 64_000;
export const MAX_TOKENS = 2_000;

function capChars(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.length > MAX_BODY_CHARS ? value.slice(0, MAX_BODY_CHARS) : value;
}

const SKIP_TAGS: ReadonlySet<string> = new Set(['script', 'style', 'head', 'title', 'noscript', 'template']);

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

export function cleanText(rawBody: unknown): string {
  if (typeof rawBody !== 'string' || !rawBody) return '';
  if (!/<[a-z/!]/i.test(rawBody)) {
    return collapseWhitespace(decodeEntities(rawBody));
  }
  const parts: string[] = [];
  let skipDepth = 0;
  const parser = new Parser({
    onopentag(name: string) {
      if (SKIP_TAGS.has(name.toLowerCase())) skipDepth += 1;
    },
    onclosetag(name: string) {
      if (SKIP_TAGS.has(name.toLowerCase()) && skipDepth > 0) skipDepth -= 1;
    },
    ontext(text: string) {
      if (skipDepth === 0) parts.push(text);
    },
  }, { decodeEntities: true });
  parser.write(rawBody);
  parser.end();
  return collapseWhitespace(parts.join(' '));
}

export function tokenize(message: SpamMessageInput | null | undefined): string[] {
  const subject = cleanText(capChars(message?.subject));
  const rawBody = typeof message?.body === 'string' && message.body
    ? message.body
    : (typeof message?.bodyHtml === 'string' ? message.bodyHtml : '');
  const body = rawBody ? cleanText(capChars(rawBody)) : '';

  const tokens: string[] = [];
  pushTokenRuns(tokens, `${subject} ${subject}`);
  pushTokenRuns(tokens, body);

  for (const url of body.match(URL_RE) ?? []) {
    const host = extractUrlHost(url);
    if (host) {
      const normalized = normalizeToken(host);
      if (normalized) tokens.push(normalized);
    }
  }

  return tokens.filter((t): t is string => t !== null).slice(0, MAX_TOKENS);
}

function pushTokenRuns(out: string[], text: string): void {
  for (const raw of text.match(WORD_RE) ?? []) {
    const token = normalizeToken(raw);
    if (token) out.push(token);
  }
}

export function normalizeToken(raw: string): string | null {
  let token = raw.toLowerCase();
  if (CJK_RE.test(token)) {
    const chars = [...token].filter(ch => !/[a-z0-9_]/i.test(ch));
    if (chars.length === 0) return null;
    token = chars[0] ?? '';
  }
  if (token.length < 2 || token.length > 30) {
    if (!(token.length === 1 && CJK_RE.test(token))) return null;
  }
  if (/^[\p{N}]+$/u.test(token)) return null;
  if (ALL_STOP_WORDS.has(token)) return null;
  return token;
}

function extractUrlHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    const m = /^https?:\/\/([^/]+)/i.exec(url);
    return m?.[1]?.toLowerCase().replace(/^www\./, '') ?? null;
  }
}

export function extractFlagFeatures(
  message: SpamMessageInput | null | undefined,
  opts: { trustedAuthservIds?: unknown } = {},
): FlagFeatures {
  const auth = parseAuthResults(message?.headers ?? null, { trustedAuthservIds: opts.trustedAuthservIds });

  const authFlags: Pick<FlagFeatures, 'dkim_pass' | 'spf_pass' | 'dmarc_pass'> = {
    dkim_pass: null, spf_pass: null, dmarc_pass: null,
  };
  for (const method of ['dkim', 'spf', 'dmarc'] as const) {
    const value = auth[method];
    authFlags[`${method}_pass`] = value === null ? null : value === 'pass' ? 1 : 0;
  }

  const subject = capChars(message?.subject);
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];

  const letters = (subject.match(/\p{L}/gu) ?? []).length;
  const upper = (subject.match(/\p{Lu}/gu) ?? []).length;

  const fromDomain = extractEmailDomain(message?.from);
  const replyToDomain = extractEmailDomain(message?.replyTo);

  return {
    ...authFlags,
    has_attachment: attachments.length > 0 ? 1 : 0,
    attachment_is_executable: attachments.some(a => {
      const ext = attachmentExtension(a);
      return ext !== null && EXECUTABLE_EXTENSIONS.has(ext);
    }) ? 1 : 0,
    all_caps_subject_ratio: letters > 0 ? upper / letters : 0,
    from_equals_reply_to_mismatch:
      fromDomain !== null && replyToDomain !== null && fromDomain !== replyToDomain ? 1 : 0,
  };
}

function extractEmailDomain(address: unknown): string | null {
  if (address === null || address === undefined) return null;
  const text = String(address);
  const angle = /<([^<>]+)>/.exec(text);
  const addr = (angle?.[1] ?? text).trim();
  const at = addr.lastIndexOf('@');
  if (at < 0) return null;
  const domain = addr.slice(at + 1).toLowerCase();
  return domain || null;
}

export function attachmentExtension(attachment: SpamAttachment | null | undefined): string | null {
  const filename = attachment?.filename ?? attachment?.name;
  if (typeof filename === 'string' && filename) {
    const base = filename.trim();
    const lastDot = base.lastIndexOf('.');
    if (lastDot > 0 && lastDot < base.length - 1) {
      return base.slice(lastDot + 1).toLowerCase();
    }
  }
  const ct = attachment?.contentType ?? attachment?.type;
  if (typeof ct === 'string' && /^\s*application\/(x-)?(exe|msdownload|vnd\.ms-)/i.test(ct)) {
    return 'exe';
  }
  return null;
}

export function tokenFingerprint(message: SpamMessageInput | null | undefined): string {
  const tokens = tokenize(message);
  const flags = extractFlagFeatures(message);
  const stable = JSON.stringify({ tokens: [...tokens].sort(), flags });
  return createHash('sha256').update(stable).digest('hex');
}
