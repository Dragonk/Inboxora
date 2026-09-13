/** A throwable with the optional fields the UI reads (HTTP status, API code). */
export interface AppError extends Error {
  status?: number;
  code?: string;
}

/**
 * Narrow an unknown catch value. Thrown values are normally Error instances; anything else is
 * wrapped so callers can read `.message`/`.status` without a scattered unknown check.
 */
export function toAppError(value: unknown): AppError {
  if (value instanceof Error) return value as AppError;
  return new Error(String(value)) as AppError;
}

