import type { RequestHandler } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidClientError, InvalidRequestError, OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

interface ClientCredentials { clientId: string; clientSecret?: string; method: 'none' | 'client_secret_post' | 'client_secret_basic'; }
/** RFC 6749 client authentication; reject mixed or conflicting credentials. */
export function parseClientCredentials(authorization: string | undefined, input: unknown): ClientCredentials {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InvalidRequestError('A form-encoded token request is required.');
  const body = input as Record<string, unknown>;
  if (authorization !== undefined) {
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
    if (!match || authorization.length > 8192) throw new InvalidClientError('Unsupported or malformed client authentication.');
    const bytes = Buffer.from(match[1], 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== match[1].replace(/=+$/, '')) throw new InvalidClientError('Malformed Basic credentials.');
    let decoded: string;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new InvalidClientError('Malformed Basic credentials.'); }
    const separator = decoded.indexOf(':');
    if (separator < 1) throw new InvalidClientError('Basic credentials require a client ID and secret.');
    let clientId: string; let clientSecret: string;
    try {
      clientId = decodeURIComponent(decoded.slice(0, separator).replace(/\+/g, ' '));
      clientSecret = decodeURIComponent(decoded.slice(separator + 1).replace(/\+/g, ' '));
    } catch { throw new InvalidClientError('Malformed Basic credentials.'); }
    if (!clientId || !clientSecret || /[\0\r\n]/.test(clientId + clientSecret)) throw new InvalidClientError('Invalid client credentials.');
    if (body.client_secret !== undefined || (body.client_id !== undefined && body.client_id !== clientId)) {
      throw new InvalidRequestError('Do not mix or conflict client authentication methods.');
    }
    return {clientId,clientSecret,method:'client_secret_basic'};
  }
  if (typeof body.client_id !== 'string' || !body.client_id || body.client_id.length > 1024) throw new InvalidClientError('Client ID is required.');
  if (body.client_secret !== undefined && (typeof body.client_secret !== 'string' || !body.client_secret || body.client_secret.length > 4096)) throw new InvalidClientError('Invalid client secret.');
  return {clientId:body.client_id,clientSecret:body.client_secret as string | undefined,
    method:body.client_secret === undefined ? 'none' : 'client_secret_post'};
}

/** The SDK validates secrets/expiry from form fields, but does not parse HTTP Basic.
 * Translate only after enforcing the registered authentication method. */
export function mcpClientAuthentication(store: OAuthRegisteredClientsStore): RequestHandler {
  return async (req,res,next) => {
    try {
      const credentials = parseClientCredentials(req.get('authorization'),req.body);
      const client = await store.getClient(credentials.clientId);
      const expected = client?.token_endpoint_auth_method ?? 'client_secret_post';
      if (!client || expected !== credentials.method) throw new InvalidClientError('Use this client’s registered authentication method.');
      req.body = {...req.body,client_id:credentials.clientId,...(credentials.clientSecret === undefined ? {} : {client_secret:credentials.clientSecret})};
      next();
    } catch (error) {
      if (!(error instanceof OAuthError)) { next(error); return; }
      const status = error instanceof InvalidClientError ? 401 : 400;
      if (status === 401) res.setHeader('WWW-Authenticate','Basic realm="Inboxora MCP", error="invalid_client"');
      res.status(status).json(error.toResponseObject());
    }
  };
}
