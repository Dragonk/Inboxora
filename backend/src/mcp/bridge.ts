import express from 'express';
import type { ErrorRequestHandler } from 'express';
import inject from 'light-my-request';
import mailRoutes from '../routes/mail.js';
import draftRoutes from '../routes/draft.js';
import calendarRoutes from '../routes/calendar.js';
import contactRoutes from '../routes/contacts.js';
import searchRoutes from '../routes/search.js';
import { setTrustedRequestUser } from '../services/trustedRequestUser.js';
import { McpError } from './policy.js';

export type BridgeMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export interface DomainResult { status: number; body: Record<string, unknown>; }
/** Ordinary provider-backed routes, without a listener or a browser session. */
const domain = express();
domain.use(express.json({ limit: '8mb' }));
domain.use('/mail', mailRoutes, draftRoutes);
domain.use('/calendar', calendarRoutes);
domain.use('/contacts', contactRoutes);
domain.use('/search', searchRoutes);
const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  console.error('MCP domain request failed:', error instanceof Error ? error.message : 'Unknown error');
  res.status(500).json({ error: 'The operation could not be completed. Its outcome may be uncertain.' });
};
domain.use(errorHandler);

/** Fixed tool paths only: this function is deliberately not exposed as a generic API tool. */
export async function domainRequest(userId: string, method: BridgeMethod, path: string, body?: Record<string, unknown>, requestId?: string): Promise<DomainResult> {
  const response = await inject((req, res) => {
    setTrustedRequestUser(req, userId);
    domain(req, res);
  }, {
    method, url: path, headers: { ...(body ? { 'content-type': 'application/json' } : {}),
      ...(requestId ? { 'x-idempotency-key': `mcp:${requestId}` } : {}) },
    ...(body ? { payload: JSON.stringify(body) } : {}),
  });
  if (!(response.headers['content-type'] || '').toString().includes('application/json')) {
    throw new McpError('DOMAIN_RESPONSE_INVALID', 'Inboxora returned an unexpected response. Do not retry a mutation automatically.', 502);
  }
  const value = response.json<unknown>();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new McpError('DOMAIN_RESPONSE_INVALID', 'Unexpected domain response.', 502);
  return { status: response.statusCode, body: value as Record<string, unknown> };
}
export async function domainRead(userId: string, path: string): Promise<Record<string, unknown>> {
  const response = await domainRequest(userId, 'GET', path);
  if (response.status >= 400) throw new McpError(typeof response.body.code === 'string' ? response.body.code : 'DOMAIN_ERROR',
    typeof response.body.error === 'string' ? response.body.error : 'The resource could not be read.', response.status);
  return response.body;
}
