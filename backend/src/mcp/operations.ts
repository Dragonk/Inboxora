import { query, withTransaction } from '../services/db.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { digest, publicOrigin } from './config.js';
import { McpError, liveGrant, type Grant } from './policy.js';
import type { DomainResult } from './bridge.js';

export interface Operation {
  id: string; grant_id: string; user_id: string; tool: string; request_id: string;
  arguments_hash: string; arguments_encrypted: string; execution_encrypted: string | null;
  scopes_snapshot: string[]; result_encrypted: string | null;
  state: 'pending' | 'approved' | 'executing' | 'succeeded' | 'partial' | 'failed' | 'uncertain' | 'denied';
  expires_at: string; started_at: string | null;
}
/** Approval binds exact validated arguments, never a model-provided summary. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .filter(([, item]) => item !== undefined).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new McpError('INVALID_ARGUMENTS', 'Arguments must be JSON values.', 400);
  return result;
}
export function decodeOperationData(value: string): Record<string, unknown> {
  const text = decrypt(value);
  if (!text) throw new McpError('RESULT_UNAVAILABLE', 'Stored operation data cannot be read.', 500);
  const result: unknown = JSON.parse(text);
  if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new McpError('RESULT_UNAVAILABLE', 'Stored operation data is invalid.', 500);
  return result as Record<string, unknown>;
}
function operationResult(row: Operation, grant: Grant): Record<string, unknown> {
  // A narrowed refresh token cannot retrieve content produced under broader permissions.
  if (!row.scopes_snapshot.every(scope => grant.scopes.some(value => value === scope))) {
    throw new McpError('SCOPE_REQUIRED', 'The current token cannot read this operation receipt.');
  }
  if (row.result_encrypted) return { operationId: row.id, state: row.state, result: decodeOperationData(row.result_encrypted) };
  const expired = ['pending', 'approved'].includes(row.state) && new Date(row.expires_at).getTime() <= Date.now();
  return { operationId: row.id, state: expired ? 'expired' : row.state,
    ...(row.state === 'pending' && !expired ? { approvalUrl: `${publicOrigin()}/ai/mcp/confirm/${row.id}`,
      instruction: 'Ask the user to review this exact operation in Inboxora. After approval, repeat the original tool with the same requestId. Do not create another requestId for a retry.' } : {}),
    ...(row.state === 'executing' || row.state === 'uncertain' ? { instruction: 'The external outcome is not confirmed. Do not retry with another requestId. Check Inboxora and the provider first.' } : {}) };
}
export async function readOperation(grant: Grant, id: string): Promise<Record<string, unknown>> {
  const current = await liveGrant(grant.id, grant.user_id, grant.scopes);
  const result = await query<Operation>('SELECT * FROM mcp_operations WHERE id=$1 AND grant_id=$2 AND user_id=$3', [id, grant.id, grant.user_id]);
  const row = result.rows[0];
  if (!row) throw new McpError('OPERATION_UNAVAILABLE', 'Operation not found.', 404);
  return operationResult(row, current);
}
export function classifyOperation(outcome: DomainResult): Operation['state'] {
  const code = String(outcome.body.code ?? '');
  if (outcome.status >= 500 || /UNKNOWN|UNCERTAIN|INFLIGHT/.test(code) || outcome.body.state === 'outcome_unknown') return 'uncertain';
  if (outcome.status >= 400 || outcome.body.ok === false) return 'failed';
  if (outcome.body.invitationError || (Array.isArray(outcome.body.failed) && outcome.body.failed.length)
    || (Array.isArray(outcome.body.pending) && outcome.body.pending.length)) return 'partial';
  if (outcome.body.partial === true || outcome.body.state === 'partial') return 'partial';
  return 'succeeded';
}

export async function runOperation(grant: Grant, tool: string, args: Record<string, unknown>,
  validate: (grant: Grant) => Promise<void>, execute: (operationId: string, prepared: Record<string, unknown>) => Promise<DomainResult>,
  prepare?: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const requestId = args.requestId;
  if (typeof requestId !== 'string' || !requestId || requestId.length > 128) throw new McpError('REQUEST_ID_REQUIRED', 'Use a stable requestId for this operation.', 400);
  let current = await liveGrant(grant.id, grant.user_id, grant.scopes);
  const payload = canonicalJson(args); const fingerprint = digest(`${tool}\n${payload}`);
  let row = (await query<Operation>('SELECT * FROM mcp_operations WHERE grant_id=$1 AND request_id=$2', [grant.id, requestId])).rows[0];
  if (!row) {
    await validate(current);
    const prepared = prepare ? await prepare() : {};
    current = await liveGrant(grant.id, grant.user_id, grant.scopes);
    row = await withTransaction(async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('mcp-operation'),hashtext($1))", [grant.user_id]);
      const prior = await db.query<Operation>('SELECT * FROM mcp_operations WHERE grant_id=$1 AND request_id=$2', [grant.id, requestId]);
      if (prior.rows[0]) return prior.rows[0];
      const count = await db.query<{ count: string }>("SELECT count(*) FROM mcp_operations WHERE user_id=$1 AND state IN ('pending','approved') AND expires_at>NOW()", [grant.user_id]);
      if (Number(count.rows[0].count) >= 100) throw new McpError('OPERATION_LIMIT', 'Review or dismiss pending operations before creating more.', 429);
      const inserted = await db.query<Operation>(`INSERT INTO mcp_operations(grant_id,user_id,request_id,tool,arguments_hash,arguments_encrypted,state,scopes_snapshot,execution_encrypted)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [grant.id, grant.user_id, requestId, tool, fingerprint, encrypt(payload), current.require_confirmation ? 'pending' : 'approved', current.scopes, encrypt(canonicalJson(prepared))]);
      return inserted.rows[0];
    });
  }
  if (!row || row.arguments_hash !== fingerprint || row.tool !== tool) throw new McpError('REQUEST_ID_CONFLICT', 'This requestId already identifies different arguments.', 409);
  const receipt = operationResult(row, current);
  // Completed operations replay even when the original resource was deleted or moved.
  if (row.state !== 'approved' || receipt.state === 'expired') return receipt;
  current = await liveGrant(grant.id, grant.user_id, grant.scopes);
  await validate(current);
  // At-most-once dispatch fence. No transaction retry surrounds provider calls.
  const claim = await query<Operation>(`UPDATE mcp_operations o SET state='executing',started_at=NOW()
    WHERE o.id=$1 AND o.state='approved' AND o.expires_at>NOW()
      AND EXISTS(SELECT 1 FROM mcp_grants g WHERE g.id=o.grant_id AND g.revoked_at IS NULL AND g.expires_at>NOW()) RETURNING o.*`, [row.id]);
  if (!claim.rows.length) return readOperation(grant, row.id);
  try {
    const outcome = await execute(row.id, row.execution_encrypted ? decodeOperationData(row.execution_encrypted) : {});
    await query(`UPDATE mcp_operations SET state=$2,result_encrypted=$3,execution_encrypted=NULL,arguments_encrypted=$4,finished_at=NOW()
      WHERE id=$1 AND state='executing'`, [row.id, classifyOperation(outcome), encrypt(JSON.stringify(outcome)), encrypt('{}')]);
  } catch (error) {
    console.error('MCP operation outcome uncertain:', row.id, error instanceof Error ? error.name : 'Unknown error');
    await query(`UPDATE mcp_operations SET state='uncertain',execution_encrypted=NULL,arguments_encrypted=$2,finished_at=NOW() WHERE id=$1 AND state='executing'`, [row.id, encrypt('{}')]);
  }
  return readOperation(grant, row.id);
}
