import express from 'express';
import type { Request, RequestHandler } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema,
  ListPromptsRequestSchema, GetPromptRequestSchema, McpError as ProtocolError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthMetadataRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { ZodError } from 'zod';
import { oauthProvider } from './oauth.js';
import { allowedOrigins, issuerUrl, mcpEnabled, publicOrigin, resourceUrl } from './config.js';
import { liveGrant, McpError, SCOPES, type Grant } from './policy.js';
import type { RegisteredTool } from './registry.js';
import { GUIDE } from './guide.js';

function limiter(limit: number, key: (req: Request) => string): RequestHandler {
  const buckets = new Map<string, { count: number; until: number }>();
  return (req, res, next) => {
    const now = Date.now(); const identity = key(req); let bucket = buckets.get(identity);
    if (!bucket || bucket.until <= now) {
      if (buckets.size >= 10000) for (const [id, item] of buckets) if (item.until <= now) buckets.delete(id);
      if (buckets.size >= 10000) { res.status(503).json({ error: 'MCP request capacity reached.' }); return; }
      bucket = { count: 0, until: now + 60000 }; buckets.set(identity, bucket);
    }
    if (++bucket.count > limit) { res.setHeader('Retry-After', Math.ceil((bucket.until - now) / 1000)); res.status(429).json({ error: 'MCP rate limit exceeded.' }); return; }
    next();
  };
}
export function createProtocolServer(grant: Grant, tools: RegisteredTool[], version = 'dev'): Server {
  const server = new Server({ name: 'inboxora', version }, { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: GUIDE });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const active = await liveGrant(grant.id, grant.user_id, grant.scopes);
    return { tools: tools.filter(tool => !tool.scope || active.scopes.includes(tool.scope)).map(tool => tool.definition) };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const tool = tools.find(candidate => candidate.definition.name === request.params.name);
    if (!tool) throw new ProtocolError(ErrorCode.InvalidParams, 'Unknown Inboxora tool.');
    try {
      const result = await tool.invoke(grant, request.params.arguments ?? {});
      const text = JSON.stringify(result);
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new McpError('RESULT_TOO_LARGE', 'Request a smaller page or a shorter body segment.', 413);
      return { content: [{ type: 'text' as const, text }], structuredContent: result,
        ...(['failed','uncertain','partial','denied','expired'].includes(String(result.state)) ? { isError: true } : {}) };
    } catch (error) {
      const result = error instanceof McpError ? { code: error.code, error: error.message }
        : error instanceof ZodError ? { code: 'INVALID_ARGUMENTS', error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') }
          : { code: 'OPERATION_FAILED', error: 'Inboxora could not complete this request. Do not retry a mutation with a different requestId.' };
      if (!(error instanceof McpError) && !(error instanceof ZodError)) console.error('MCP tool failed:', tool.definition.name, error instanceof Error ? error.name : 'UnknownError');
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result, isError: true };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: 'inboxora://guide', name: 'Inboxora MCP guide', mimeType: 'text/plain', description: 'Permissions, confirmations and safe mail handling.' }] }));
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    if (request.params.uri !== 'inboxora://guide') throw new ProtocolError(ErrorCode.InvalidParams, 'Unknown resource.');
    return { contents: [{ uri: 'inboxora://guide', mimeType: 'text/plain', text: GUIDE }] };
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: 'inboxora_assistant', description: 'Safely work with email, calendar and contacts.' }] }));
  server.setRequestHandler(GetPromptRequestSchema, async request => {
    if (request.params.name !== 'inboxora_assistant') throw new ProtocolError(ErrorCode.InvalidParams, 'Unknown prompt.');
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `${GUIDE}\nStart with get_capabilities. Ask what mailbox task I need. Do not mutate anything until I request it.` } }] };
  });
  return server;
}

/** Mount before browser CORS/session middleware. Remote MCP is bearer-only. */
export function createMcpRouter(version = 'dev', tools?: RegisteredTool[]) {
  const router = express.Router();
  if (!mcpEnabled()) {
    router.all('/mcp', (_req, res) => { res.status(404).json({ error: 'MCP is disabled by the administrator.' }); });
    return router;
  }
  const origin = publicOrigin(); const origins = allowedOrigins(); const endpoint = resourceUrl();
  const authBase = `${origin}/oauth/mcp`;
  router.use(['/mcp', '/oauth/mcp'], (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    const suppliedOrigin = req.get('origin');
    if (suppliedOrigin && !origins.includes(suppliedOrigin)) { res.status(403).json({ error: 'Origin is not allowed.' }); return; }
    if (suppliedOrigin) { res.setHeader('Access-Control-Allow-Origin', suppliedOrigin); res.vary('Origin'); }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID');
    res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Retry-After, MCP-Session-Id');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });
  router.use(mcpAuthMetadataRouter({ oauthMetadata: {
    issuer: issuerUrl(), authorization_endpoint: `${authBase}/authorize`, token_endpoint: `${authBase}/token`,
    registration_endpoint: `${authBase}/register`, revocation_endpoint: `${authBase}/revoke`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code','refresh_token'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none','client_secret_post','client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none','client_secret_post','client_secret_basic'], scopes_supported: [...SCOPES],
    authorization_response_iss_parameter_supported: true,
  }, resourceServerUrl: new URL(endpoint), scopesSupported: [...SCOPES], resourceName: 'Inboxora' }));
  router.use('/oauth/mcp/authorize', authorizationHandler({ provider: oauthProvider }));
  router.use('/oauth/mcp/token', tokenHandler({ provider: oauthProvider }));
  router.use('/oauth/mcp/register', clientRegistrationHandler({ clientsStore: oauthProvider.clientsStore }));
  router.use('/oauth/mcp/revoke', revocationHandler({ provider: oauthProvider }));
  router.use('/mcp', limiter(180, req => req.ip || 'unknown'));
  router.use('/mcp', requireBearerAuth({ verifier: oauthProvider, resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp` }));
  router.use('/mcp', limiter(120, req => String(req.auth?.extra?.grantId || req.ip)));
  router.use('/mcp', express.json({ limit: '8mb' }));
  const active = new Map<string, number>();
  router.post('/mcp', async (req, res) => {
    const auth = req.auth;
    if (!auth || typeof auth.extra?.grantId !== 'string' || typeof auth.extra?.userId !== 'string') { res.status(401).end(); return; }
    const grant = await liveGrant(auth.extra.grantId, auth.extra.userId, auth.scopes);
    const availableTools = tools ?? (await import('./catalog.js')).tools;
    if ((active.get(grant.user_id) ?? 0) >= 4) { res.setHeader('Retry-After', '2'); res.status(429).json({ error: 'Too many concurrent MCP operations.' }); return; }
    active.set(grant.user_id, (active.get(grant.user_id) ?? 0) + 1);
    // Avoid importing provider routes during application initialization or when
    // MCP is disabled. In particular, do not re-enter the index/worker graph.
    const server = createProtocolServer(grant, availableTools, version);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true,
      enableDnsRebindingProtection: true, allowedHosts: [new URL(origin).host], allowedOrigins: origins });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    finally {
      const remaining = (active.get(grant.user_id) ?? 1) - 1;
      if (remaining) active.set(grant.user_id, remaining); else active.delete(grant.user_id);
      await server.close();
    }
  });
  router.all('/mcp', (_req, res) => { res.setHeader('Allow', 'POST, OPTIONS'); res.status(405).json({ error: 'Use Streamable HTTP POST; this server is stateless.' }); });
  return router;
}
