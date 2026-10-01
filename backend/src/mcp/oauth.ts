import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { query, withTransaction } from '../services/db.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { digest, issuerUrl, publicOrigin, resourceUrl, secretToken } from './config.js';
import { SCOPES, READ_SCOPES, type Grant, type GrantInput, liveGrant, validateOwnedRestrictions } from './policy.js';

interface StoredAuthorization {
  client_id: string; request_encrypted: string; grant_id: string | null;
}
interface StoredToken { grant_id: string; scopes: string[]; resource: string; consumed_at: string | null; client_id: string | null; }
interface AuthorizationRequest { state?: string; scopes: string[]; codeChallenge: string; redirectUri: string; resource: string; }
function unpack<T>(value: string): T {
  const text = decrypt(value);
  if (!text) throw new Error('MCP authorization data is unreadable.');
  return JSON.parse(text) as T;
}
function checkResource(resource?: URL): void {
  if (resource && resource.href !== resourceUrl()) throw new InvalidTargetError('The resource must be the Inboxora MCP endpoint.');
}
export function validateClientRedirects(uris: string[]): void {
  if (!uris.length || uris.length > 10) throw new InvalidClientMetadataError('Register between one and ten redirect URIs.');
  for (const uri of uris) {
    const url = new URL(uri);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.hash || url.username || url.password || uri.length > 2048) {
      throw new InvalidClientMetadataError('Redirect URIs require HTTPS, except HTTP loopback callbacks, and cannot contain credentials or fragments.');
    }
  }
}
const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(id) {
    const result = await query<{ metadata_encrypted: string }>('SELECT metadata_encrypted FROM mcp_clients WHERE id=$1', [id]);
    return result.rows[0] ? unpack<OAuthClientInformationFull>(result.rows[0].metadata_encrypted) : undefined;
  },
  async registerClient(metadata) {
    validateClientRedirects(metadata.redirect_uris);
    if (metadata.client_name && metadata.client_name.length > 120) throw new InvalidClientMetadataError('Client name is too long.');
    if (metadata.token_endpoint_auth_method && !['none', 'client_secret_post', 'client_secret_basic'].includes(metadata.token_endpoint_auth_method)) {
      throw new InvalidClientMetadataError('Unsupported token endpoint authentication method.');
    }
    const client: OAuthClientInformationFull = { ...metadata, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) };
    await query('INSERT INTO mcp_clients(id,metadata_encrypted) VALUES($1,$2)', [client.client_id, encrypt(JSON.stringify(client))]);
    return client;
  },
};
async function tokensForGrant(client: PoolClient, grant: Grant, scopes: string[]): Promise<OAuthTokens> {
  const access = secretToken(); const refresh = secretToken();
  await client.query(`INSERT INTO mcp_tokens(token_hash,grant_id,kind,scopes,resource,expires_at) VALUES
    ($1,$3,'access',$4,$5,LEAST(NOW()+INTERVAL '1 hour',$6::timestamptz)),
    ($2,$3,'refresh',$4,$5,LEAST(NOW()+INTERVAL '30 days',$6::timestamptz))`,
  [digest(access), digest(refresh), grant.id, scopes, resourceUrl(), grant.expires_at]);
  return { access_token: access, refresh_token: refresh, token_type: 'Bearer',
    expires_in: Math.max(0, Math.min(3600, Math.floor((new Date(grant.expires_at).getTime() - Date.now()) / 1000))), scope: scopes.join(' ') };
}
export const oauthProvider: OAuthServerProvider = {
  clientsStore,
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    checkResource(params.resource);
    const scopes = params.scopes?.length ? params.scopes : READ_SCOPES;
    if (scopes.some(scope => !SCOPES.includes(scope as typeof SCOPES[number]))) throw new InvalidScopeError('Unknown Inboxora permission.');
    const id = secretToken();
    const request: AuthorizationRequest = { ...params, scopes, resource: resourceUrl() };
    await query('INSERT INTO mcp_authorizations(id_hash,client_id,request_encrypted) VALUES($1,$2,$3)', [digest(id), client.client_id, encrypt(JSON.stringify(request))]);
    res.redirect(`${publicOrigin()}/ai/mcp/authorize?request=${encodeURIComponent(id)}`);
  },
  async challengeForAuthorizationCode(client, code) {
    const result = await query<StoredAuthorization>(`SELECT client_id,request_encrypted,grant_id FROM mcp_authorizations
      WHERE code_hash=$1 AND client_id=$2 AND consumed_at IS NULL AND expires_at>NOW()`, [digest(code), client.client_id]);
    if (!result.rows[0]) throw new InvalidGrantError('Invalid or expired authorization code.');
    return unpack<AuthorizationRequest>(result.rows[0].request_encrypted).codeChallenge;
  },
  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    checkResource(resource);
    return withTransaction(async db => {
      const result = await db.query<StoredAuthorization>(`SELECT client_id,request_encrypted,grant_id FROM mcp_authorizations
        WHERE code_hash=$1 AND client_id=$2 AND consumed_at IS NULL AND expires_at>NOW() FOR UPDATE`, [digest(code), client.client_id]);
      const row = result.rows[0];
      if (!row?.grant_id) throw new InvalidGrantError('Invalid or expired authorization code.');
      const request = unpack<AuthorizationRequest>(row.request_encrypted);
      if (redirectUri !== request.redirectUri) throw new InvalidGrantError('The redirect URI must match the authorization request.');
      const grant = await liveGrant(row.grant_id);
      await db.query('UPDATE mcp_authorizations SET consumed_at=NOW() WHERE code_hash=$1', [digest(code)]);
      return tokensForGrant(db, grant, grant.scopes);
    });
  },
  async exchangeRefreshToken(client, token, scopes, resource) {
    checkResource(resource);
    const result = await withTransaction(async db => {
      const rows = await db.query<StoredToken>(`SELECT t.grant_id,t.scopes,t.resource,t.consumed_at,g.client_id FROM mcp_tokens t
        JOIN mcp_grants g ON g.id=t.grant_id WHERE t.token_hash=$1 AND t.kind='refresh' AND t.expires_at>NOW()
          AND g.client_id=$2 FOR UPDATE OF t`, [digest(token), client.client_id]);
      const row = rows.rows[0];
      if (!row || row.resource !== resourceUrl()) return null;
      if (row.consumed_at) {
        // Commit revocation before returning the error: throwing here would roll it back.
        await db.query('UPDATE mcp_grants SET revoked_at=COALESCE(revoked_at,NOW()) WHERE id=$1', [row.grant_id]);
        return null;
      }
      const grant = await liveGrant(row.grant_id, undefined, row.scopes);
      if (scopes?.some(scope => !grant.scopes.includes(scope as typeof SCOPES[number]))) throw new InvalidScopeError('Refresh cannot increase the approved permissions.');
      await db.query('UPDATE mcp_tokens SET consumed_at=NOW() WHERE token_hash=$1', [digest(token)]);
      return tokensForGrant(db, grant, scopes ?? grant.scopes);
    });
    if (!result) throw new InvalidGrantError('Invalid or replayed refresh token. Reconnect this integration.');
    return result;
  },
  async verifyAccessToken(token): Promise<AuthInfo> {
    if (token.length < 32 || token.length > 200) throw new InvalidTokenError('Invalid access token.');
    const rows = await query<StoredToken & { expires_at: string }>(`SELECT t.grant_id,t.scopes,t.resource,t.consumed_at,t.expires_at,g.client_id
      FROM mcp_tokens t JOIN mcp_grants g ON g.id=t.grant_id WHERE t.token_hash=$1 AND t.kind IN ('access','personal')
        AND t.consumed_at IS NULL AND t.expires_at>NOW()`, [digest(token)]);
    const row = rows.rows[0];
    if (!row || row.resource !== resourceUrl()) throw new InvalidTokenError('Invalid or expired access token.');
    let grant: Grant;
    try { grant = await liveGrant(row.grant_id, undefined, row.scopes); }
    catch { throw new InvalidTokenError('Integration revoked or expired.'); }
    await query(`UPDATE mcp_grants SET last_used_at=NOW() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<NOW()-INTERVAL '1 minute')`, [grant.id]);
    return { token, clientId: grant.client_id ?? grant.id, scopes: grant.scopes, resource: new URL(resourceUrl()),
      expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000), extra: { grantId: grant.id, userId: grant.user_id } };
  },
  async revokeToken(client, request: OAuthTokenRevocationRequest) {
    await query(`UPDATE mcp_grants SET revoked_at=COALESCE(revoked_at,NOW()) WHERE client_id=$1
      AND id IN (SELECT grant_id FROM mcp_tokens WHERE token_hash=$2)`, [client.client_id, digest(request.token)]);
  },
};

export async function authorizationInfo(id: string) {
  const result = await query<StoredAuthorization>(`SELECT client_id,request_encrypted,grant_id FROM mcp_authorizations
    WHERE id_hash=$1 AND grant_id IS NULL AND consumed_at IS NULL AND expires_at>NOW()`, [digest(id)]);
  const row = result.rows[0];
  if (!row) throw new InvalidGrantError('This authorization request has expired or has already been used.');
  const client = await clientsStore.getClient(row.client_id);
  if (!client) throw new InvalidGrantError('Client no longer exists.');
  const request = unpack<AuthorizationRequest>(row.request_encrypted);
  return { name: client.client_name || 'MCP client', clientId: client.client_id, scopes: request.scopes, redirectUri: request.redirectUri };
}
export async function approveAuthorization(id: string, userId: string, input: GrantInput | null): Promise<string> {
  if (input) await validateOwnedRestrictions(userId, input.restrictions);
  return withTransaction(async db => {
    const result = await db.query<StoredAuthorization>(`SELECT client_id,request_encrypted,grant_id FROM mcp_authorizations
      WHERE id_hash=$1 AND grant_id IS NULL AND consumed_at IS NULL AND expires_at>NOW() FOR UPDATE`, [digest(id)]);
    const row = result.rows[0];
    if (!row) throw new InvalidGrantError('Authorization request expired or already used.');
    const request = unpack<AuthorizationRequest>(row.request_encrypted);
    const redirect = new URL(request.redirectUri);
    if (request.state !== undefined) redirect.searchParams.set('state', request.state);
    redirect.searchParams.set('iss', issuerUrl());
    if (!input) {
      await db.query('UPDATE mcp_authorizations SET consumed_at=NOW() WHERE id_hash=$1', [digest(id)]);
      redirect.searchParams.set('error', 'access_denied');
      return redirect.href;
    }
    if (input.scopes.some(scope => !request.scopes.includes(scope))) throw new InvalidScopeError('Consent cannot exceed the requested permissions.');
    const grant = await db.query<{ id: string }>(`INSERT INTO mcp_grants(user_id,client_id,name,scopes,restrictions,require_confirmation,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,NOW()+$7*INTERVAL '1 day') RETURNING id`,
    [userId, row.client_id, input.name, input.scopes, JSON.stringify(input.restrictions), input.requireConfirmation, input.expiresInDays]);
    const code = secretToken();
    await db.query(`UPDATE mcp_authorizations SET grant_id=$2,code_hash=$3,expires_at=NOW()+INTERVAL '2 minutes' WHERE id_hash=$1`, [digest(id), grant.rows[0].id, digest(code)]);
    redirect.searchParams.set('code', code);
    return redirect.href;
  });
}
export async function createPersonalToken(userId: string, input: GrantInput) {
  await validateOwnedRestrictions(userId, input.restrictions);
  const token = secretToken();
  const grant = await withTransaction(async db => {
    const result = await db.query<{ id: string; expires_at: string }>(`INSERT INTO mcp_grants(user_id,name,scopes,restrictions,require_confirmation,expires_at)
      VALUES($1,$2,$3,$4,$5,NOW()+$6*INTERVAL '1 day') RETURNING id,expires_at`,
    [userId, input.name, input.scopes, JSON.stringify(input.restrictions), input.requireConfirmation, input.expiresInDays]);
    await db.query(`INSERT INTO mcp_tokens(token_hash,grant_id,kind,scopes,resource,expires_at) VALUES($1,$2,'personal',$3,$4,$5)`,
      [digest(token), result.rows[0].id, input.scopes, resourceUrl(), result.rows[0].expires_at]);
    return result.rows[0];
  });
  return { ...grant, token, endpoint: resourceUrl() };
}
