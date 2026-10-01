import { createHash, randomBytes } from 'node:crypto';

export function publicOrigin(): string {
  const url = new URL(process.env.APP_URL || 'http://localhost:3000');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('MCP requires an HTTPS APP_URL.');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('MCP APP_URL must be an origin without a path, query or credentials.');
  return url.origin;
}
export function resourceUrl(): string { return `${publicOrigin()}/mcp`; }
export function issuerUrl(): string { return `${publicOrigin()}/`; }
export function secretToken(): string { return randomBytes(32).toString('base64url'); }
export function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
