import { query } from '../services/db.js';
import { encrypt } from '../services/encryption.js';

/** Erase sensitive payloads, but retain operation IDs/fingerprints against replay. */
export async function maintainMcpData(): Promise<void> {
  const empty = encrypt('{}');
  await query(`WITH stale AS (
    SELECT id FROM mcp_operations WHERE state IN ('pending','approved') AND expires_at<=NOW()
      AND execution_encrypted IS NOT NULL ORDER BY expires_at LIMIT 200
  ) UPDATE mcp_operations o SET arguments_encrypted=$1,execution_encrypted=NULL
    FROM stale WHERE o.id=stale.id AND o.state IN ('pending','approved') AND o.expires_at<=NOW()`, [empty]);
  // No retry or provider call: a crashed/inordinately slow execution remains uncertain.
  await query(`WITH stale AS (
    SELECT id FROM mcp_operations WHERE state='executing' AND started_at<NOW()-INTERVAL '1 hour'
      ORDER BY started_at LIMIT 200
  ) UPDATE mcp_operations o SET state='uncertain',finished_at=NOW(),arguments_encrypted=$1,execution_encrypted=NULL
    FROM stale WHERE o.id=stale.id AND o.state='executing'`, [empty]);
  await query(`WITH old AS (
    SELECT id FROM mcp_operations WHERE finished_at<NOW()-INTERVAL '30 days' AND result_encrypted IS NOT NULL
      ORDER BY finished_at LIMIT 200
  ) UPDATE mcp_operations o SET result_encrypted=NULL FROM old WHERE o.id=old.id`);
  await query(`DELETE FROM mcp_tokens WHERE token_hash IN (
    SELECT token_hash FROM mcp_tokens WHERE expires_at<=NOW() ORDER BY expires_at LIMIT 1000)`);
  await query(`DELETE FROM mcp_authorizations WHERE id_hash IN (
    SELECT id_hash FROM mcp_authorizations WHERE expires_at<=NOW() ORDER BY expires_at LIMIT 1000)`);
  await query(`DELETE FROM mcp_clients WHERE id IN (
    SELECT c.id FROM mcp_clients c WHERE c.created_at<NOW()-INTERVAL '30 days'
      AND NOT EXISTS(SELECT 1 FROM mcp_grants g WHERE g.client_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM mcp_authorizations a WHERE a.client_id=c.id)
    ORDER BY c.created_at LIMIT 200)`);
}

export function startMcpMaintenance(): () => void {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running || !process.env.ENCRYPTION_KEY) return;
    running = true;
    try { await maintainMcpData(); }
    catch (error) { console.error('MCP maintenance failed:', error instanceof Error ? error.name : 'UnknownError'); }
    finally { running = false; }
  };
  const timer = setInterval(() => void tick(), 5 * 60000);
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
