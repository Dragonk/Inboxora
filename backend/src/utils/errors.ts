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

