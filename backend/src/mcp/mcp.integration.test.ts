import { maintainMcpData } from './maintenance.js';
import { decrypt } from '../services/encryption.js';
import 'express-async-errors';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import session from 'express-session';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

// Do not boot the production worker, connect to personal mailboxes or send mail.
vi.mock('../index.js', () => ({ imapManager: {} }));
import { pool, query } from '../services/db.js';
import { createMcpRouter, createProtocolServer } from './server.js';
import apiRouter from './api.js';
import { createPersonalToken, oauthProvider } from './oauth.js';
import { grantSchema, liveGrant, requireAccount } from './policy.js';
import { readTool, writeTool } from './registry.js';
import { tools as domainTools } from './catalog.js';
import { secretToken, digest } from './config.js';
import { readOperation } from './operations.js';

const record = (value: unknown) => z.record(z.string(), z.unknown()).parse(value);
const oauthClient = z.object({ client_id: z.string(), client_secret: z.string().optional(), redirect_uris: z.array(z.string()).min(1) });
const tokenPair = z.object({ access_token: z.string(), refresh_token: z.string() });
const enabled = process.env.REQUIRE_MCP_POSTGRES === '1';
describe.skipIf(!enabled)('native MCP over HTTP and PostgreSQL', () => {
  const userId = randomUUID(); const foreignUserId = randomUUID(); const accountId = randomUUID(); const foreignAccountId = randomUUID();
  let server: HttpServer; let origin: string; let cookie: string; let foreignCookie: string; let calls = 0; let serverCreationFailures = 0;
  const clients: Client[] = []; const registeredClientIds: string[] = [];
  const priorUrl = process.env.APP_URL; const priorEnabled = process.env.MCP_ENABLED;
  async function browser(path: string, body?: unknown, browserCookie = cookie, method = body === undefined ? 'GET' : 'POST') {
    return fetch(`${origin}/api/mcp${path}`, { method, headers: { cookie: browserCookie, 'content-type': 'application/json', 'x-requested-with': 'MailFlow' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function connect(token: string) {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    clients.push(client); return client;
  }
  async function token(name: string, options: Record<string, unknown> = {}) {
    return createPersonalToken(userId, grantSchema.parse({ name, scopes: ['mail.read','mail.send'], restrictions: { accounts: [accountId] }, ...options }));
  }
  beforeAll(async () => {
    await query('SELECT id FROM mcp_grants LIMIT 0');
    await query('INSERT INTO users(id,username) VALUES($1,$2),($3,$4)', [userId, `mcp-${userId}`, foreignUserId, `mcp-${foreignUserId}`]);
    await query(`INSERT INTO email_accounts(id,user_id,name,email_address) VALUES($1,$2,'Mine','owner@example.test'),($3,$4,'Foreign','foreign@example.test')`, [accountId,userId,foreignAccountId,foreignUserId]);
    process.env.MCP_ENABLED = 'true';
    const app = express(); server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.APP_URL = origin;
    const fixtureTools = [
      readTool('test_read', 'Synthetic read', 'mail.read', { accountId: z.uuid() }, async (grant, args) => { await requireAccount(grant, args.accountId); return { owner: grant.user_id }; }),
      writeTool('test_write', 'Synthetic external write', 'mail.send', { accountId: z.uuid(), subject: z.string() },
        async (grant, args) => requireAccount(grant, args.accountId), async (_grant, args) => { calls++; await new Promise(resolve => setTimeout(resolve, 40)); return { status: 200, body: { subject: args.subject } }; }),
      ...domainTools,
    ];
    app.set('mcpTools', fixtureTools);
    app.use(createMcpRouter('integration-test', fixtureTools, (...args) => {
      if (serverCreationFailures > 0) { serverCreationFailures--; throw new Error('Synthetic protocol construction failure'); }
      return createProtocolServer(...args);
    }));
    app.use(express.json()); app.use(session({ secret: 'synthetic-mcp-test-session', resave: false, saveUninitialized: false }));
    // This route exists only in a loopback, in-process test app, never in production.
    app.post('/fixture/login/:who', (req,res) => { req.session.userId = req.params.who === 'foreign' ? foreignUserId : userId; res.json({ ok: true }); });
    app.use('/api/mcp', apiRouter);
    cookie = (await fetch(`${origin}/fixture/login/owner`, { method: 'POST' })).headers.get('set-cookie')!.split(';')[0];
    foreignCookie = (await fetch(`${origin}/fixture/login/foreign`, { method: 'POST' })).headers.get('set-cookie')!.split(';')[0];
  });
  afterAll(async () => {
    for (const client of clients) await client.close();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[userId,foreignUserId]]);
    if (registeredClientIds.length) await query('DELETE FROM mcp_clients WHERE id=ANY($1::text[])', [registeredClientIds]);
    await pool.end();
    if (priorUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = priorUrl;
    if (priorEnabled === undefined) delete process.env.MCP_ENABLED; else process.env.MCP_ENABLED = priorEnabled;
  });
  it('advertises the exact protected resource and requires bearer authentication', async () => {
    const unauthenticated = await fetch(`${origin}/mcp`, { method:'POST', headers:{'content-type':'application/json'}, body:'{}' });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toContain(`${origin}/.well-known/oauth-protected-resource/mcp`);
    const resource = record(await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json());
    expect(resource.resource).toBe(`${origin}/mcp`); expect(resource.authorization_servers).toEqual([`${origin}/`]);
    const metadata = record(await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json());
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']); expect(metadata.registration_endpoint).toBe(`${origin}/oauth/mcp/register`);
  });
  it('rejects browser origins and forged identities before returning mail data', async () => {
    const grant = await token('origin test');
    const response = await fetch(`${origin}/mcp`, { method:'POST', headers:{'content-type':'application/json',authorization:`Bearer ${grant.token}`,origin:'https://attacker.example','x-user-id':userId}, body:'{}' });
    expect(response.status).toBe(403);
    const forged = await fetch(`${origin}/api/mcp/grants`, { headers:{ 'x-user-id':userId,authorization:`Bearer ${grant.token}` } });
    expect(forged.status).toBe(401);
  });
  it('initializes the official SDK, filters tools and enforces ownership on invocation', async () => {
    const grant = await token('read-only', { scopes:['mail.read'] }); const client = await connect(grant.token);
    const listed = await client.listTools();
    expect(listed.tools.some(tool => tool.name==='test_read')).toBe(true);
    expect(listed.tools.find(tool => tool.name==='test_read')?._meta?.securitySchemes).toEqual([{type:'oauth2',scopes:['mail.read']}]);
    expect(listed.tools.some(tool => tool.name==='send_email')).toBe(false);
    expect((await client.callTool({ name:'test_read',arguments:{accountId} })).structuredContent).toEqual({ owner:userId });
    expect((await client.callTool({ name:'test_read',arguments:{accountId:foreignAccountId} })).isError).toBe(true);
    const forbidden = await client.callTool({ name:'test_write',arguments:{accountId,subject:'not permitted',requestId:randomUUID()} });
    expect(forbidden.isError).toBe(true);
    expect(JSON.stringify(forbidden._meta)).toContain('insufficient_scope');
    expect((await client.readResource({ uri:'inboxora://guide' })).contents[0]).toMatchObject({ mimeType:'text/plain' });
  });
  it('releases concurrency slots after repeated protocol construction failures', async () => {
    const grant = await token('Construction failure test');
    serverCreationFailures = 5;
    for (let index=0;index<5;index++) {
      const response = await fetch(`${origin}/mcp`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${grant.token}`},body:'{}'});
      expect(response.status).toBe(500);
    }
    const client = await connect(grant.token);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });
  it('stores hashes and ciphertext, not personal tokens, and rejects foreign resource grants', async () => {
    const grant = await token('stored token');
    const row = (await query<{ token_hash:string }>('SELECT token_hash FROM mcp_tokens WHERE grant_id=$1', [grant.id])).rows[0];
    expect(row.token_hash).toBe(digest(grant.token)); expect(row.token_hash).not.toBe(grant.token);
    await expect(token('foreign scope', { restrictions:{accounts:[foreignAccountId]} })).rejects.toThrow(/unavailable/);
  });
  it('requires browser approval, binds exact arguments and dispatches concurrent retries once', async () => {
    const grant = await token('approval test'); const client = await connect(grant.token);
    const args = { accountId,subject:'One intended delivery',requestId:randomUUID() }; const before = calls;
    const first = await client.callTool({ name:'test_write',arguments:args }); const operationId = String(record(first.structuredContent).operationId);
    expect(record(first.structuredContent).state).toBe('pending'); expect(calls).toBe(before);
    expect((await client.callTool({ name:'test_write',arguments:{...args,subject:'Changed recipient or content'} })).isError).toBe(true);
    expect((await browser(`/operations/${operationId}/decision`,{approve:true},foreignCookie)).status).toBe(409);
    const bearerApproval = await fetch(`${origin}/api/mcp/operations/${operationId}/decision`, { method:'POST',headers:{authorization:`Bearer ${grant.token}`,'content-type':'application/json','x-requested-with':'MailFlow'},body:'{"approve":true}' });
    expect(bearerApproval.status).toBe(401);
    const approved = await browser(`/operations/${operationId}/decision`,{approve:true});
    expect(approved.status).toBe(200);
    expect(record(await approved.json()).state).toBe('succeeded');
    // Browser approval is the dispatch trigger; the AI client does not have to resubmit the mutation.
    expect(calls).toBe(before+1);
    await Promise.all([client.callTool({name:'test_write',arguments:args}),client.callTool({name:'test_write',arguments:args})]);
    const receipt = await readOperation(await liveGrant(grant.id,userId),operationId);
    expect(receipt.state).toBe('succeeded'); expect(calls).toBe(before+1);
    expect(record((await client.callTool({name:'test_write',arguments:args})).structuredContent).state).toBe('succeeded'); expect(calls).toBe(before+1);
    const row = (await query<{ arguments_encrypted:string; execution_encrypted:string|null }>('SELECT arguments_encrypted,execution_encrypted FROM mcp_operations WHERE id=$1',[operationId])).rows[0];
    expect(row.arguments_encrypted).not.toContain(args.subject); expect(row.execution_encrypted).toBeNull();
  });
  it('revokes already issued tokens and pending approvals immediately', async () => {
    const grant = await token('revoked'); const client = await connect(grant.token);
    const args = {accountId,subject:'Never dispatch',requestId:randomUUID()}; const result = await client.callTool({name:'test_write',arguments:args});
    const operationId = String(record(result.structuredContent).operationId);
    expect((await browser(`/grants/${grant.id}`,undefined,cookie,'DELETE')).status).toBe(200);
    await expect(oauthProvider.verifyAccessToken(grant.token)).rejects.toThrow(/revoked|expired/);
    expect((await browser(`/operations/${operationId}/decision`,{approve:true})).status).toBe(409);
    expect((await query<{state:string}>('SELECT state FROM mcp_operations WHERE id=$1',[operationId])).rows[0].state).toBe('denied');
  });
  it('executes real local calendar and contact CRUD through the MCP domain bridge', async () => {
    const calendarId = randomUUID(); const bookId = randomUUID();
    await query("INSERT INTO calendars(id,user_id,owner_user_id,name,source) VALUES($1,$2,$2,'MCP calendar','local')",[calendarId,userId]);
    await query("INSERT INTO address_books(id,user_id,name,source) VALUES($1,$2,'MCP contacts','local')",[bookId,userId]);
    const grant = await token('Local domain tools',{scopes:['calendar.read','calendar.write','contacts.read','contacts.write'],requireConfirmation:false,
      restrictions:{calendars:[calendarId],addressBooks:[bookId],accounts:[]}});
    const client = await connect(grant.token);
    const invoke = async (name:string,args:Record<string,unknown>) => {
      const response = await client.callTool({name,arguments:{...args,requestId:randomUUID()}});
      const result = record(response.structuredContent);
      expect(result, JSON.stringify(response)).toMatchObject({state:'succeeded'});
      return record(record(result.result).body);
    };
    const event = {calendarId,summary:'Synthetic appointment',startsAt:'2026-10-03T10:00:00Z',endsAt:'2026-10-03T11:00:00Z',
      description:'MCP integration fixture',location:null,url:null,organizer:null,allDay:false,timezone:'Europe/Warsaw',attendees:[],sendInvites:false};
    await invoke('create_event',event);
    const stored = (await query<{id:string;etag:string}>("SELECT id,etag FROM calendar_events WHERE calendar_id=$1 AND summary='Synthetic appointment'",[calendarId])).rows[0];
    expect(stored).toBeDefined();
    const listed = await client.callTool({name:'list_events',arguments:{from:'2026-10-03T00:00:00Z',to:'2026-10-04T00:00:00Z'}});
    expect(record(listed.structuredContent).events).toEqual(expect.arrayContaining([expect.objectContaining({summary:'Synthetic appointment'})]));
    await invoke('update_event',{...event,eventId:stored.id,expectedEtag:stored.etag,summary:'Changed appointment'});
    const updated = (await query<{etag:string}>('SELECT etag FROM calendar_events WHERE id=$1',[stored.id])).rows[0];
    await invoke('delete_event',{calendarId,eventId:stored.id,expectedEtag:updated.etag});
    expect((await query('SELECT id FROM calendar_events WHERE id=$1',[stored.id])).rows).toEqual([]);
    await invoke('create_contact',{addressBookId:bookId,displayName:'Synthetic Contact',emails:[{value:'synthetic@example.test'}],contactDates:[{label:'Birthday',value:'1990-05-06'}],addresses:[{type:'work',locality:'Warsaw',postalCode:'00-001'}]});
    const contact = (await query<{id:string;etag:string}>("SELECT id,etag FROM contacts WHERE address_book_id=$1 AND display_name='Synthetic Contact'",[bookId])).rows[0];
    expect(contact).toBeDefined();
    const found = await client.callTool({name:'search_contacts',arguments:{query:'synthetic'}});
    expect(record(found.structuredContent).contacts).toEqual(expect.arrayContaining([expect.objectContaining({id:contact.id})]));
    await invoke('update_contact',{contactId:contact.id,expectedEtag:contact.etag,displayName:'Updated Contact'});
    const fresh = (await query<{etag:string}>('SELECT etag FROM contacts WHERE id=$1',[contact.id])).rows[0];
    await invoke('delete_contact',{contactId:contact.id,expectedEtag:fresh.etag});
    expect((await query('SELECT id FROM contacts WHERE id=$1',[contact.id])).rows).toEqual([]);
  });
  it('reads cached mail and a singleton thread without marking the message read', async () => {
    const messageId = randomUUID();
    await query(`INSERT INTO messages(id,account_id,uid,folder,message_id,subject,body_text,is_read)
      VALUES($1,$2,9001,'INBOX','<mcp-read@example.test>','Read test','Private synthetic body',false)`,[messageId,accountId]);
    const grant = await token('Mail reader',{scopes:['mail.read']});
    const client = await connect(grant.token);
    const email = await client.callTool({name:'get_email',arguments:{messageId}});
    expect(email.isError).not.toBe(true);
    expect(record(email.structuredContent).text).toBe('Private synthetic body');
    const fullText = 'first segment '.repeat(20) + 'second segment '.repeat(20);
    await query('UPDATE messages SET body_text=$2 WHERE id=$1',[messageId,fullText]);
    const first = record((await client.callTool({name:'fetch',arguments:{id:messageId,maxCharacters:100}})).structuredContent);
    expect(first.text).toBe(fullText.slice(0,100));
    const nextOffset = record(first.metadata).nextTextOffset;
    expect(nextOffset).toBe(100);
    const next = record((await client.callTool({name:'fetch',arguments:{id:messageId,textOffset:nextOffset,maxCharacters:100}})).structuredContent);
    expect(next.text).toBe(fullText.slice(100,200));
    expect(record(next.metadata).textOffset).toBe(100);

    const thread = await client.callTool({name:'get_thread',arguments:{messageId}});
    expect(record(thread.structuredContent).messages).toEqual(expect.arrayContaining([expect.objectContaining({id:messageId})]));
    expect((await query<{is_read:boolean}>('SELECT is_read FROM messages WHERE id=$1',[messageId])).rows[0].is_read).toBe(false);
  });
  it('erases expired payloads and parks interrupted writes without reopening their request IDs', async () => {
    const grant = await token('Retention'); const client = await connect(grant.token);
    const args = {accountId,subject:'Sensitive pending content',requestId:randomUUID()};
    const pending = record((await client.callTool({name:'test_write',arguments:args})).structuredContent);
    await query("UPDATE mcp_operations SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[pending.operationId]);
    await maintainMcpData();
    const cleared = (await query<{arguments_encrypted:string;execution_encrypted:string|null}>('SELECT arguments_encrypted,execution_encrypted FROM mcp_operations WHERE id=$1',[pending.operationId])).rows[0];
    expect(decrypt(cleared.arguments_encrypted)).toBe('{}'); expect(cleared.execution_encrypted).toBeNull();
    const before = calls;
    expect(record((await client.callTool({name:'test_write',arguments:args})).structuredContent).state).toBe('expired');
    expect(calls).toBe(before);
    const other = record((await client.callTool({name:'test_write',arguments:{...args,requestId:randomUUID()}})).structuredContent);
    await query("UPDATE mcp_operations SET state='executing',started_at=NOW()-INTERVAL '2 hours' WHERE id=$1",[other.operationId]);
    await maintainMcpData();
    expect((await readOperation(await liveGrant(grant.id,userId),String(other.operationId))).state).toBe('uncertain');
    expect(calls).toBe(before);
  });
  it.each(['none','client_secret_basic','client_secret_post'] as const)('runs OAuth %s with S256, redirect/resource binding, rotation and replay revocation', async method => {
    const registration = await fetch(`${origin}/oauth/mcp/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'SDK OAuth test',redirect_uris:['http://127.0.0.1:34567/callback'],token_endpoint_auth_method:method,grant_types:['authorization_code','refresh_token'],response_types:['code']})});
    expect(registration.status).toBe(201); const client = oauthClient.parse(await registration.json()); registeredClientIds.push(client.client_id);
    const verifier = secretToken(); const challenge = createHash('sha256').update(verifier).digest('base64url');
    const parameters = new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:client.redirect_uris[0],scope:'mail.read mail.send',code_challenge:challenge,code_challenge_method:'S256',state:'opaque-client-state',resource:`${origin}/mcp`});
    const authorization = await fetch(`${origin}/oauth/mcp/authorize?${parameters}`, {redirect:'manual'});
    expect(authorization.status).toBe(302);
    const pending = new URL(authorization.headers.get('location')!).searchParams.get('request')!;
    const approval = await browser(`/authorizations/${pending}`,{approve:true,grant:{name:'OAuth consent',scopes:['mail.read','mail.send'],restrictions:{accounts:[accountId]}}});
    expect(approval.status).toBe(200); const redirect = new URL(z.object({redirectUrl:z.string()}).parse(await approval.json()).redirectUrl);
    expect(redirect.searchParams.get('state')).toBe('opaque-client-state'); expect(redirect.searchParams.get('iss')).toBe(`${origin}/`);
    const code = redirect.searchParams.get('code')!;
    const credentials: Record<string,string> = method === 'client_secret_post' ? {client_secret:client.client_secret!} : {};
    const headers: Record<string,string> = {'content-type':'application/x-www-form-urlencoded'};
    if (method === 'client_secret_basic') headers.authorization = 'Basic '+Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
    const exchange = (values: Record<string,string>) => fetch(`${origin}/oauth/mcp/token`,{method:'POST',headers,body:new URLSearchParams({client_id:client.client_id,...credentials,...values})});
    const wrongHeaders: Record<string,string> = {'content-type':'application/x-www-form-urlencoded'};
    const wrongFields: Record<string,string> = {client_id:client.client_id,grant_type:'refresh_token',refresh_token:'invalid-fixture-token'};
    if (method === 'client_secret_post') wrongHeaders.authorization='Basic '+Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
    else wrongFields.client_secret=client.client_secret ?? 'not-a-public-client-secret';
    const wrongMethod = await fetch(`${origin}/oauth/mcp/token`,{method:'POST',headers:wrongHeaders,body:new URLSearchParams(wrongFields)});
    expect(wrongMethod.status).toBe(401);
    expect(await wrongMethod.json()).toMatchObject({error:'invalid_client'});
    const fields = {grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:client.redirect_uris[0],resource:`${origin}/mcp`};
    expect((await exchange({...fields,code_verifier:secretToken()})).status).toBe(400);
    expect((await exchange({...fields,redirect_uri:'http://127.0.0.1:34567/other'})).status).toBe(400);
    expect((await exchange({...fields,resource:'https://other.example/mcp'})).status).toBe(400);
    const response = await exchange(fields); expect(response.status).toBe(200); const pair = tokenPair.parse(await response.json());
    expect((await exchange(fields)).status).toBe(400);
    expect((await oauthProvider.verifyAccessToken(pair.access_token)).scopes).toEqual(['mail.read','mail.send']);
    expect((await exchange({grant_type:'refresh_token',refresh_token:pair.refresh_token,scope:'contacts.write'})).status).toBe(400);
    const narrowed = await exchange({grant_type:'refresh_token',refresh_token:pair.refresh_token,scope:'mail.read'});
    expect(narrowed.status).toBe(200); const next = tokenPair.parse(await narrowed.json());
    expect((await oauthProvider.verifyAccessToken(next.access_token)).scopes).toEqual(['mail.read']);
    expect((await exchange({grant_type:'refresh_token',refresh_token:pair.refresh_token})).status).toBe(400);
    await expect(oauthProvider.verifyAccessToken(next.access_token)).rejects.toThrow(/revoked|expired/);
    await expect(oauthProvider.verifyAccessToken(pair.access_token)).rejects.toThrow(/revoked|expired/);
    const revokedRefresh = await exchange({grant_type:'refresh_token',refresh_token:next.refresh_token});
    expect(revokedRefresh.status).toBe(400);
    expect(await revokedRefresh.json()).toMatchObject({error:'invalid_grant'});
    const revoke = await fetch(`${origin}/oauth/mcp/revoke`,{method:'POST',headers,body:new URLSearchParams({client_id:client.client_id,...credentials,token:pair.access_token})});
    expect(revoke.status).toBe(200);
  });
});
