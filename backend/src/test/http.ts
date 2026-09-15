import type { NextFunction, Request, Response } from 'express';
import type { SessionData } from 'express-session';

/**
 * Route handlers and middleware take the real Express \`Request\`/\`Response\`, but a unit test only
 * needs the few members the code under test reads. Each \`*Double\` interface merges the real framework
 * interface onto an empty runtime object, so \`Object.assign(parts, new XDouble())\` returns the
 * caller's own object (the empty instance contributes no properties) typed as the framework type.
 * No assertion is needed, and nothing changes at runtime.
 */
interface RequestDouble extends Request {}
class RequestDouble {}

interface ResponseDouble extends Response {}
class ResponseDouble {}

type TestSession = SessionData & NonNullable<Request['session']>;
interface SessionDouble extends TestSession {}
class SessionDouble {}

export function mockRequest<T extends object>(parts: T): Request & T {
  return Object.assign(parts, new RequestDouble());
}

export function mockResponse<T extends object>(parts: T): Response & T {
  return Object.assign(parts, new ResponseDouble());
}

/** A minimal session for tests that only set a few fields. */
export function mockSession<T extends object>(parts: T): TestSession & T {
  return Object.assign(parts, new SessionDouble());
}

export function mockNext(): NextFunction {
  return () => {};
}
