import type { NextFunction, Request, Response } from 'express';
import type { SessionData } from 'express-session';

/**
 * Route handlers and middleware take the real Express \`Request\`/\`Response\`, but a unit test only
 * needs the few members the code under test reads. These factories adapt a plain test object to the
 * Express types in one place, so individual tests stay free of casts. This file is the only place in
 * the codebase where a test double is asserted to a framework type.
 */
export function mockRequest<T extends object>(parts: T): Request & T {
  return parts as unknown as Request & T;
}

export function mockResponse<T extends object>(parts: T = {} as T): Response & T {
  return parts as unknown as Response & T;
}

/** A minimal session for tests that only set a few fields. */
export function mockSession<T extends object>(parts: T): SessionData & T {
  return parts as unknown as SessionData & T;
}

export function mockNext(): NextFunction {
  return (() => {}) as NextFunction;
}

