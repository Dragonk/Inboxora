import { query } from '../services/db.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { digest, publicOrigin } from './config.js';
import { McpError, liveGrant, type Grant } from './policy.js';
import type { DomainResult } from './bridge.js';

export interface Operation {
  id: string; grant_id: string; user_id: string; tool: string; request_id: string;
  arguments_hash: string; arguments_encrypted: string; result_encrypted: string | null;
  state: 'pending' | 'approved' | 'executing' | 'succeeded' | 'failed' | 'uncertain' | 'denied';
  expires_at: string; started_at: string | null;
}
/** Approval binds exact validated arguments, never a model-provided summary. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .filter(([, item]) => item !== undefined).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new McpError('INVALID_ARGUMENTS', 'Arguments must be JSON values.', 400);
  return result;
}
function operationResult(row: Operation): Record<string, unknown> {
  if (row.result_encrypted) {
    const text = decrypt(row.result_encrypted);
    if (!text) throw new McpError('RESULT_UNAVAILABLE', 'The stored operation result cannot be read.', 500);
    return { operationId: row.id, state: row.state, result: JSON.parse(text) as unknown };
  }
  return { operationId: row.id, state: row.state,
    ...(row.state === 'pending' ? { approvalUrl: `${publicOrigin()}/ai/mcp/confirm/${row.id}`,
      instruction: 'Ask the user to review this exact operation in Inboxora. After approval, repeat the original tool with the same requestId. Do not create another requestId for a retry.' } : {}),
    ...(row.state === 'executing' || row.state === 'uncertain' ? { instruction: 'The external outcome is not yet confirmed. Do not retry using another requestId. Check Inboxora and the provider before doing anything further.' } : {}) };
}
export async function readOperation(grant: Grant, id: string): Promise<Record<string, unknown>> {
  const result = await query<Operation>('SELECT * FROM mcp_operations WHERE id=$1 AND grant_id=$2 AND user_id=$3', [id, grant.id, grant.user_id]);
  const row = result.rows[0];
  if (!row) throw new McpError('OPERATION_UNAVAILABLE', 'Operation not found.', 404);
  return operationResult(row);
}

export async function runOperation(grant: Grant, tool: string, args: Record<string, unknown>,
  validate: (grant: Grant) => Promise<void>, execute: (operationId: string) => Promise<DomainResult>): Promise<Record<string, unknown>> {
  const requestId = args.requestId;
  if (typeof requestId !== 'string' || !requestId || requestId.length > 128) throw new McpError('REQUEST_ID_REQUIRED', 'Use a stable requestId for this operation.', 400);
  let current = await liveGrant(grant.id, grant.user_id, grant.scopes);
  await validate(current);
  const payload = canonicalJson(args); const fingerprint = digest(`${tool}\n${payload}`);
  await query(`INSERT INTO mcp_operations(grant_id,user_id,request_id,tool,arguments_hash,arguments_encrypted,state)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(grant_id,request_id) DO NOTHING`,
  [grant.id, grant.user_id, requestId, tool, fingerprint, encrypt(payload), current.require_confirmation ? 'pending' : 'approved']);
  const result = await query<Operation>('SELECT * FROM mcp_operations WHERE grant_id=$1 AND request_id=$2', [grant.id, requestId]);
  const row = result.rows[0];
  if (!row || row.arguments_hash !== fingerprint || row.tool !== tool) throw new McpError('REQUEST_ID_CONFLICT', 'This requestId already identifies different arguments.', 409);
  if (row.state !== 'approved') return operationResult(row);
  current = await liveGrant(grant.id, grant.user_id, grant.scopes);
  await validate(current);
  // At-most-once dispatch fence. No transaction retry surrounds provider calls.
  const claim = await query<Operation>(`UPDATE mcp_operations o SET state='executing',started_at=NOW()
    WHERE o.id=$1 AND o.state='approved' AND o.expires_at>NOW()
      AND EXISTS(SELECT 1 FROM mcp_grants g WHERE g.id=o.grant_id AND g.revoked_at IS NULL AND g.expires_at>NOW()) RETURNING o.*`, [row.id]);
  if (!claim.rows.length) {
    if (new Date(row.expires_at).getTime() <= Date.now()) throw new McpError('APPROVAL_EXPIRED', 'This approval has expired. Review the operation again with a new requestId.', 409);
    return readOperation(grant, row.id);
  }
  try {
    const outcome = await execute(row.id);
    const state = outcome.status >= 500 ? 'uncertain' : outcome.status >= 400 ? 'failed' : 'succeeded';
    await query(`UPDATE mcp_operations SET state=$2,result_encrypted=$3,finished_at=NOW() WHERE id=$1 AND state='executing'`,
      [row.id, state, encrypt(JSON.stringify(outcome))]);
  } catch (error) {
    console.error('MCP operation outcome uncertain:', row.id, error instanceof Error ? error.name : 'Unknown error');
    await query(`UPDATE mcp_operations SET state='uncertain',finished_at=NOW() WHERE id=$1 AND state='executing'`, [row.id]);
  }
  return readOperation(grant, row.id);
}
