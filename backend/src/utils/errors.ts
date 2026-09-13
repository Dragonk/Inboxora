/** A throwable with the optional fields this codebase reads (Postgres codes, HTTP status). */
export interface AppError extends Error {
  code?: string;
  status?: number;
  statusCode?: number;
  details?: unknown;
}

/**
 * Narrow an unknown catch value. Thrown values are normally Error instances; anything else is
 * wrapped so callers can read `.message`/`.code` without a scattered unknown check.
 */
export function toAppError(value: unknown): AppError {
  if (value instanceof Error) return value as AppError;
  return new Error(String(value)) as AppError;
}

