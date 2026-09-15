// Common shape of errors raised by HTTP/DB/network helpers in this codebase.
// Declared globally so call sites do not need a cast to read these fields.
export {};

declare global {
  interface Error {
    statusCode?: number;
    status?: number;
    code?: string;
    details?: unknown;
    imapError?: unknown;
  }
}
