/** A throwable with the optional fields this codebase reads (Postgres codes, HTTP status). */
export interface AppError extends Error {
  code?: string;
  status?: number;
  statusCode?: number;
  details?: unknown;
  /** IMAP: the server response code (e.g. NO/BAD) and its text. */
  serverResponseCode?: string;
  responseText?: string;
  /** Fetch/HTTP: the response headers when the error carries them. */
  headers?: Record<string, string>;
}

/**
 * Narrow an unknown catch value. Thrown values are normally Error instances; anything else is
 * wrapped so callers can read `.message`/`.code` without a scattered unknown check.
 */
export function toAppError(value: unknown): AppError {
  if (value instanceof Error) return value as AppError;
  if (value && typeof value === "object") {
    const record = value as { message?: unknown };
    const message = typeof record.message === "string" ? record.message : String(value);
    return Object.assign(new Error(message), value) as AppError;
  }
  return new Error(String(value)) as AppError;
}


/**
 * The message for a body the JSON parser rejected as too large.
 *
 * The parser rejects the whole request before any route runs, so the route cannot
 * explain its own limit — and a single attachment-flavoured message is wrong for a
 * contact or calendar import, where "total attachment size" describes something the
 * user was not doing. The message is chosen from the path instead.
 */
export function requestTooLargeMessage(path: string): string {
  const target = typeof path === 'string' ? path : '';
  if ((target.startsWith('/api/contacts/') || target.startsWith('/api/calendar/')) && target.includes('/import/')) {
    return 'The file is too large. Import files must be smaller than 900 KB.';
  }
  if (target.startsWith('/api/gtd/pet/import')) {
    // A spritesheet is uploaded as a base64 body, so its decoded cap is 5 MB.
    return 'The image is too large. The spritesheet must be smaller than 5 MB.';
  }
  if (target.startsWith('/api/mail/send') || target.startsWith('/api/mail/draft')) {
    return 'Request too large. Total attachment size must not exceed 25 MB.';
  }
  return 'Request too large.';
}
