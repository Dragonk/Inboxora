import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../services/db.js';
import { encrypt } from '../services/encryption.js';
import { attachmentDisposition } from '../utils/contentDisposition.js';
import { requireAuth } from '../middleware/auth.js';
import { sessionUserId } from '../utils/query.js';
import { authorizationInfo, approveAuthorization, createPersonalToken } from './oauth.js';
import { grantPermissionsSchema, grantSchema, liveGrant, McpError, SCOPES, validateOwnedRestrictions } from './policy.js';
import { mcpEnabled, resourceUrl } from './config.js';
import { decodeOperationData, type Operation } from './operations.js';
import type { RegisteredTool } from './registry.js';
import { reprepareEditedMail } from './mailApprovalEdit.js';

const router = Router();
router.use(requireAuth);
router.use((req, res, next) => {
  // This surface is deliberately browser-session only. A bearer token cannot approve itself.
  if (!req.session?.userId || req.session.locked) { res.status(403).json({ code: 'BROWSER_SESSION_REQUIRED', error: 'Unlock Inboxora to manage AI integrations.' }); return; }
  if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.get('X-Requested-With') !== 'MailFlow') { res.status(403).json({ code: 'CSRF_REQUIRED', error: 'A same-origin browser request is required.' }); return; }
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
const uuid = z.uuid();
const requestToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
router.get('/config', (_req, res) => {
  let endpoint: string | null = null; let configurationError = false;
  try { endpoint = resourceUrl(); } catch { configurationError = true; }
  res.json({ enabled: mcpEnabled(), endpoint, configurationError, scopes: SCOPES });
});
router.get('/resources', async (req, res) => {
  const userId = sessionUserId(req);
  const [accounts, folders, calendars, books] = await Promise.all([
    query('SELECT id,name,email_address FROM email_accounts WHERE user_id=$1 AND enabled=true ORDER BY name,id', [userId]),
    query('SELECT f.id,f.account_id,f.path,f.name FROM folders f JOIN email_accounts a ON a.id=f.account_id WHERE a.user_id=$1 AND a.enabled=true ORDER BY a.name,f.path', [userId]),
    query('SELECT id,name,source,read_only FROM calendars WHERE user_id=$1 AND owner_user_id=$1 ORDER BY name,id', [userId]),
    query('SELECT id,name,source FROM address_books WHERE user_id=$1 ORDER BY name,id', [userId]),
  ]);
  res.json({ accounts: accounts.rows, folders: folders.rows, calendars: calendars.rows, addressBooks: books.rows });
});
router.get('/grants', async (req, res) => {
  const result = await query(`SELECT id,name,client_id,scopes,restrictions,require_confirmation,created_at,last_used_at,expires_at,revoked_at
    FROM mcp_grants WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200`, [sessionUserId(req)]);
  res.json({ grants: result.rows });
});
router.post('/grants/:id', async (req, res) => {
  const id = uuid.parse(req.params.id); const userId = sessionUserId(req);
  const input = grantPermissionsSchema.parse(req.body);
  await validateOwnedRestrictions(userId, input.restrictions);
  const updated = await withTransaction(async db => {
    const current = await db.query<{ id: string }>("SELECT id FROM mcp_grants WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>NOW() FOR UPDATE", [id,userId]);
    if (!current.rows.length) return null;
    const grant = await db.query("UPDATE mcp_grants SET scopes=$3,restrictions=$4,require_confirmation=$5 WHERE id=$1 AND user_id=$2 RETURNING id,name,client_id,scopes,restrictions,require_confirmation,created_at,last_used_at,expires_at,revoked_at",
      [id,userId,input.scopes,JSON.stringify(input.restrictions),input.requireConfirmation]);
    // Permission edits are an explicit browser action. Apply the same ceiling to
    // already-issued active tokens so reductions and additions take effect now.
    await db.query("UPDATE mcp_tokens SET scopes=$3 WHERE grant_id=$1 AND consumed_at IS NULL AND expires_at>NOW() AND EXISTS(SELECT 1 FROM mcp_grants g WHERE g.id=$1 AND g.user_id=$2)",
      [id,userId,input.scopes]);
    // Pending approvals were prepared under the old permissions. Require a fresh
    // operation rather than executing a snapshot whose authorization just changed.
    await db.query("UPDATE mcp_operations SET state='denied',arguments_encrypted=$3,execution_encrypted=NULL,finished_at=NOW() WHERE grant_id=$1 AND user_id=$2 AND state IN ('pending','approved')",
      [id,userId,encrypt('{}')]);
    return grant.rows[0];
  });
  if (!updated) { res.status(409).json({ code:'GRANT_UNAVAILABLE', error:'This integration is revoked or expired.' }); return; }
  res.json({ grant: updated });
});

router.post('/tokens', async (req, res) => {
  if (!mcpEnabled()) { res.status(503).json({ code: 'MCP_DISABLED', error: 'MCP is disabled by the administrator.' }); return; }
  const result = await createPersonalToken(sessionUserId(req), grantSchema.parse(req.body));
  res.status(201).json(result);
});
router.delete('/grants/:id', async (req, res) => {
  const id = uuid.parse(req.params.id); const userId = sessionUserId(req);
  const found = await withTransaction(async db => {
    const grant = await db.query('UPDATE mcp_grants SET revoked_at=COALESCE(revoked_at,NOW()) WHERE id=$1 AND user_id=$2 RETURNING id', [id, userId]);
    if (!grant.rows.length) return false;
    await db.query(`UPDATE mcp_operations SET state='denied',arguments_encrypted=$3,execution_encrypted=NULL,finished_at=NOW()
      WHERE grant_id=$1 AND user_id=$2 AND state IN ('pending','approved')`, [id, userId, encrypt('{}')]);
    return true;
  });
  if (!found) { res.status(404).json({ code: 'GRANT_UNAVAILABLE', error: 'Integration not found.' }); return; }
  res.json({ revoked: true });
});
router.get('/authorizations/:request', async (req, res) => {
  if (!mcpEnabled()) { res.status(503).json({ code: 'MCP_DISABLED', error: 'MCP is disabled by the administrator.' }); return; }
  res.json(await authorizationInfo(requestToken.parse(req.params.request)));
});
const decision = z.discriminatedUnion('approve', [z.object({ approve: z.literal(false) }).strict(), z.object({ approve: z.literal(true), grant: grantSchema }).strict()]);
router.post('/authorizations/:request', async (req, res) => {
  if (!mcpEnabled()) { res.status(503).json({ code: 'MCP_DISABLED', error: 'MCP is disabled by the administrator.' }); return; }
  const input = decision.parse(req.body);
  const redirectUrl = await approveAuthorization(requestToken.parse(req.params.request), sessionUserId(req), input.approve ? input.grant : null);
  res.json({ redirectUrl });
});
router.get('/operations', async (req, res) => {
  const result = await query(`SELECT o.id,o.tool,o.state,o.created_at,o.expires_at,o.finished_at,g.name AS integration_name
    FROM mcp_operations o JOIN mcp_grants g ON g.id=o.grant_id WHERE o.user_id=$1 ORDER BY o.created_at DESC LIMIT 100`, [sessionUserId(req)]);
  res.json({ operations: result.rows });
});
/** Never render base64 upload payloads or raw HTML in the human confirmation screen. */
function reviewArguments(value: unknown, key = '', depth = 0): unknown {
  if (depth > 12) return '[depth limit]';
  if (key === 'content' && typeof value === 'string') return { bytes: Buffer.byteLength(value, 'base64') };
  if (Array.isArray(value)) return value.map(item => reviewArguments(item, '', depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name,item]) => [name, reviewArguments(item, name, depth + 1)]));
  return value;
}
router.get('/operations/:id', async (req, res) => {
  const result = await query<Operation & { integration_name: string }>(`SELECT o.*,g.name AS integration_name FROM mcp_operations o
    JOIN mcp_grants g ON g.id=o.grant_id WHERE o.id=$1 AND o.user_id=$2`, [uuid.parse(req.params.id), sessionUserId(req)]);
  const row = result.rows[0];
  if (!row) { res.status(404).json({ code: 'OPERATION_UNAVAILABLE', error: 'Operation not found.' }); return; }
  const execution = row.execution_encrypted ? decodeOperationData(row.execution_encrypted) : {};
  res.json({ id: row.id, tool: row.tool, state: row.state, expiresAt: row.expires_at, integrationName: row.integration_name,
    arguments: reviewArguments(decodeOperationData(row.arguments_encrypted)), review: execution.review ?? null,
    result: row.result_encrypted ? decodeOperationData(row.result_encrypted) : null });
});
const mailEdit = z.object({
  to: z.array(z.string().trim().min(3).max(320)).max(100),
  cc: z.array(z.string().trim().min(3).max(320)).max(100),
  bcc: z.array(z.string().trim().min(3).max(320)).max(100),
  subject: z.string().max(998),
  body: z.string().max(500000),
  bodyIsHtml: z.boolean(),
  bodyChanged: z.boolean(),
  signature: z.string().max(100000),
  signatureIsHtml: z.boolean(),
  signatureChanged: z.boolean(),
  priority: z.enum(['high','normal','low']).optional(),
  keepAttachmentIndexes: z.array(z.number().int().min(0).max(999)).max(100).optional(),
  newAttachments: z.array(z.object({
    filename: z.string().trim().min(1).max(255),
    content: z.string().min(1).max(220 * 1024 * 1024),
    contentType: z.string().max(120).optional(),
  }).strict()).max(100).optional(),
}).strict();
router.get('/operations/:id/attachments/:index', async (req, res) => {
  const id = uuid.parse(req.params.id); const userId = sessionUserId(req);
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index > 999) { res.status(400).json({ code:'INVALID_ATTACHMENT', error:'Invalid attachment index.' }); return; }
  const found = await query<Operation>(`SELECT * FROM mcp_operations WHERE id=$1 AND user_id=$2 AND state='pending' AND expires_at>NOW()`, [id,userId]);
  const row = found.rows[0];
  if (!row?.execution_encrypted) { res.status(404).json({ code:'ATTACHMENT_UNAVAILABLE', error:'Attachment not found.' }); return; }
  const current = decodeOperationData(row.execution_encrypted) as { payload?: { attachments?: Array<{ filename?: string; content?: string; contentType?: string }> } };
  const attachment = current.payload?.attachments?.[index];
  if (!attachment || typeof attachment.content !== 'string') { res.status(404).json({ code:'ATTACHMENT_UNAVAILABLE', error:'Attachment not found.' }); return; }
  const bytes = Buffer.from(attachment.content, 'base64');
  if (bytes.toString('base64') !== attachment.content) { res.status(409).json({ code:'ATTACHMENT_UNAVAILABLE', error:'Attachment data is invalid.' }); return; }
  const contentType = typeof attachment.contentType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(attachment.contentType)
    ? attachment.contentType : 'application/octet-stream';
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type',contentType);
  res.setHeader('Content-Disposition', attachmentDisposition(attachment.filename || 'attachment'));
  res.end(bytes);
});
router.post('/operations/:id/edit', async (req, res) => {
  const id = uuid.parse(req.params.id); const userId = sessionUserId(req); const edit = mailEdit.parse(req.body);
  const found = await query<Operation>(`SELECT * FROM mcp_operations WHERE id=$1 AND user_id=$2 AND state='pending' AND expires_at>NOW()`, [id,userId]);
  const row = found.rows[0];
  if (!row || !['send_email','reply_email','reply_all_email','forward_email'].includes(row.tool) || !row.execution_encrypted) {
    res.status(409).json({ code:'EDIT_UNAVAILABLE', error:'This pending message can no longer be edited.' }); return;
  }
  const current = decodeOperationData(row.execution_encrypted);
  if (!current.payload || typeof current.payload !== 'object' || Array.isArray(current.payload) || typeof current.senderEmail !== 'string') {
    res.status(409).json({ code:'EDIT_UNAVAILABLE', error:'The prepared message is unavailable.' }); return;
  }
  const prepared = await reprepareEditedMail(userId, current as never, edit);
  const stored = await query(`UPDATE mcp_operations SET execution_encrypted=$3
    WHERE id=$1 AND user_id=$2 AND state='pending' AND expires_at>NOW() RETURNING id`, [id,userId,encrypt(JSON.stringify(prepared))]);
  if (!stored.rows.length) { res.status(409).json({ code:'EDIT_UNAVAILABLE', error:'The operation changed while the message was being edited.' }); return; }
  res.json({ id, review: prepared.review });
});
router.post('/operations/:id/decision', async (req, res) => {
  const input = z.object({ approve: z.boolean() }).strict().parse(req.body);
  const userId = sessionUserId(req);
  const result = await query<Operation>(`UPDATE mcp_operations o SET state=$3,approved_at=CASE WHEN $3='approved' THEN NOW() ELSE NULL END,
      expires_at=CASE WHEN $3='approved' THEN NOW()+INTERVAL '10 minutes' ELSE expires_at END,
      execution_encrypted=CASE WHEN $3='denied' THEN NULL ELSE execution_encrypted END,
      arguments_encrypted=CASE WHEN $3='denied' THEN $4 ELSE arguments_encrypted END
    WHERE o.id=$1 AND o.user_id=$2 AND o.state='pending' AND o.expires_at>NOW()
      AND EXISTS(SELECT 1 FROM mcp_grants g WHERE g.id=o.grant_id AND g.revoked_at IS NULL AND g.expires_at>NOW()) RETURNING o.*`,
  [uuid.parse(req.params.id), userId, input.approve ? 'approved' : 'denied', encrypt('{}')]);
  const row = result.rows[0];
  if (!row) { res.status(409).json({ code: 'APPROVAL_UNAVAILABLE', error: 'This operation expired, changed state or belongs to a revoked integration.' }); return; }
  if (!input.approve) { res.json({ operationId: row.id, state: 'denied' }); return; }

  // Browser approval is the user's final action. Execute the exact encrypted,
  // pre-resolved operation immediately instead of requiring the AI client to
  // submit a second mutation. runOperation's state transition remains the
  // at-most-once fence, so a later same-requestId call only reads the receipt.
  const configuredTools = req.app.get('mcpTools') as RegisteredTool[] | undefined;
  const availableTools = configuredTools ?? (await import('./catalog.js')).tools;
  const tool = availableTools.find(candidate => candidate.definition.name === row.tool);
  if (!tool) {
    // A rolling deployment may remove a tool while an old approval page is open.
    // Keep the exact approved receipt rather than guessing a replacement action.
    res.json({ operationId: row.id, state: 'approved', executionDeferred: true });
    return;
  }
  const grant = await liveGrant(row.grant_id, userId, row.scopes_snapshot);
  const receipt = await tool.invoke(grant, decodeOperationData(row.arguments_encrypted));
  res.json(receipt);
});
router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) { res.status(400).json({ code: 'INVALID_ARGUMENTS', error: 'Some integration settings are invalid.', fields: error.issues.map(issue => issue.path.join('.')) }); return; }
  if (error instanceof McpError) { res.status(error.status).json({ code: error.code, error: error.message }); return; }
  if (error && typeof error === 'object' && 'errorCode' in error && typeof error.errorCode === 'string') { res.status(400).json({ code: error.errorCode, error: 'The authorization request could not be completed. Reconnect the client.' }); return; }
  console.error('MCP settings failed:', error instanceof Error ? error.name : 'UnknownError');
  res.status(500).json({ code: 'MCP_SETTINGS_FAILED', error: 'AI integration settings could not be updated.' });
});
export default router;
