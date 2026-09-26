import type { PoolClient } from 'pg';
import { query, withSavepoint } from '../../db.js';
import { GraphApiError, graphGet, graphUrl } from './graphApiClient.js';
import type { GraphApiOptions } from './graphApiClient.js';
import { GRAPH_MESSAGE_SELECT, providerUidForGraphMessage } from './graphMail.js';
import type { GraphMessage } from './graphMail.js';
import { graphHasEnvelope } from './graphDeltaFields.js';

/** Use one local lock order for Graph page writes, confirmed moves and cleanup. */
export async function lockGraphMailWrites(client: PoolClient, accountId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`graph-mail:${accountId}`]);
}

export interface GraphLocationSnapshot {
  id: string;
  provider_message_id: string;
  folder: string;
  synced_at: string | null;
  has_envelope?: boolean;
}
export type GraphLocationChecks = ReadonlyMap<string, GraphLocationSnapshot>;

/** Only matching snapshots can apply a location read obtained before a concurrent move. */
export function sameGraphLocation(a: GraphLocationSnapshot, b: GraphLocationSnapshot): boolean {
  return a.id === b.id && a.provider_message_id === b.provider_message_id
    && a.folder === b.folder && a.synced_at === b.synced_at;
}

/**
 * Project a confirmed provider MOVE in one transaction, preserving the source UUID.
 * A compatibility UID collision is retried, never deleted. An exact provider-ID
 * duplicate is retained as a hidden alias, preserving dependent local data.
 */
export async function projectGraphMove(client: PoolClient, input: {
  accountId: string; connectionId: string; rowId: string;
  sourceId: string; targetId: string; targetPath: string;
}): Promise<{ moved: boolean; uid: string | null }> {
  await lockGraphMailWrites(client, input.accountId);
  const source = await client.query<GraphLocationSnapshot & { uid: string }>(
    `SELECT id, provider_message_id, folder, synced_at::text AS synced_at, uid::text AS uid
       FROM messages WHERE id=$1 AND account_id=$2 FOR UPDATE`, [input.rowId,input.accountId],
  );
  const row = source.rows[0];
  if (!row || (row.provider_message_id !== input.sourceId && row.provider_message_id !== input.targetId)) {
    return { moved: false, uid: null };
  }
  if (row.provider_message_id === input.targetId && row.folder === input.targetPath) {
    await client.query('DELETE FROM graph_pending_message_removals WHERE message_row_id=$1',[row.id]);
    return { moved: true, uid: row.uid };
  }
  const duplicates = await client.query<{ id: string }>(
    `SELECT id FROM messages WHERE account_id=$1 AND provider_message_id=$2 AND id<>$3 FOR UPDATE`,
    [input.accountId,input.targetId,row.id],
  );
  for (const copy of duplicates.rows) {
    await client.query(
      `UPDATE messages original SET body_html=COALESCE(original.body_html,copy.body_html),
         body_text=COALESCE(original.body_text,copy.body_text),
         attachments=COALESCE(original.attachments,copy.attachments)
       FROM messages copy WHERE original.id=$1 AND copy.id=$2`,[row.id,copy.id],
    );
    await client.query('UPDATE messages SET provider_message_id=NULL,is_deleted=true WHERE id=$1',[copy.id]);
    await client.query(
      `INSERT INTO graph_legacy_message_bindings
       (legacy_message_id,canonical_message_id,account_id,connection_id,status,evidence)
       VALUES ($1,$2,$3,$4,'bound',jsonb_build_object('kind','confirmed_provider_move'))
       ON CONFLICT (legacy_message_id) DO UPDATE SET
         canonical_message_id=EXCLUDED.canonical_message_id,status='bound',evidence=EXCLUDED.evidence,updated_at=NOW()
       WHERE graph_legacy_message_bindings.account_id=EXCLUDED.account_id
         AND graph_legacy_message_bindings.connection_id=EXCLUDED.connection_id`,
      [copy.id,row.id,input.accountId,input.connectionId],
    );
    await client.query('DELETE FROM graph_pending_message_removals WHERE message_row_id=$1',[copy.id]);
  }
  let uid: string | null = null;
  for (let attempt=0;attempt<8 && uid===null;attempt++) {
    const candidate=providerUidForGraphMessage(input.targetId,attempt);
    try {
      const changed=await withSavepoint(client,`graph_move_${attempt}`,async()=>client.query(
        `UPDATE messages SET folder=$1,provider_message_id=$2,uid=$3,synced_at=clock_timestamp(),
           is_deleted=false,is_archived=false WHERE id=$4 AND account_id=$5 RETURNING id`,
        [input.targetPath,input.targetId,candidate,row.id,input.accountId],
      ));
      if ((changed.rowCount??0)>0) uid=candidate;
    } catch (error) {
      if (typeof error==='object' && error!==null && 'code' in error && error.code==='23505') continue;
      throw error;
    }
  }
  if (uid===null) throw new Error('Unable to reserve a Graph move UID');
  await client.query(
    `INSERT INTO graph_mail_move_receipts
       (account_id,old_provider_message_id,message_row_id,connection_id,source_folder_path,target_folder_path,new_provider_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (account_id,old_provider_message_id) DO UPDATE SET
       message_row_id=EXCLUDED.message_row_id,connection_id=EXCLUDED.connection_id,
       source_folder_path=EXCLUDED.source_folder_path,target_folder_path=EXCLUDED.target_folder_path,
       new_provider_message_id=EXCLUDED.new_provider_message_id,recorded_at=clock_timestamp()`,
    [input.accountId,input.sourceId,row.id,input.connectionId,row.folder,input.targetPath,input.targetId],
  );
  await client.query(
    `UPDATE graph_legacy_message_bindings b
       SET evidence=b.evidence || jsonb_build_object('physical_move_confirmed',true),updated_at=NOW()
     FROM messages legacy WHERE b.legacy_message_id=legacy.id AND b.canonical_message_id=$1
       AND b.account_id=$2 AND b.connection_id=$3 AND b.status='bound'
       AND legacy.account_id=$2 AND legacy.folder=$4 AND legacy.provider_message_id IS NULL`,
    [row.id,input.accountId,input.connectionId,row.folder],
  );
  // A legacy source selected through a verified binding is an alias, not a
  // second remote copy to leave visible in the old Spam folder after MOVE.
  await client.query(
    `UPDATE messages legacy SET is_deleted=true FROM graph_legacy_message_bindings b
     WHERE b.legacy_message_id=legacy.id AND b.canonical_message_id=$1
       AND b.account_id=$2 AND b.connection_id=$3 AND b.status='bound'
       AND legacy.account_id=$2 AND legacy.folder=$4 AND legacy.provider_message_id IS NULL`,
    [row.id,input.accountId,input.connectionId,row.folder],
  );
  await client.query('DELETE FROM graph_pending_message_removals WHERE message_row_id=$1',[row.id]);
  return { moved:true,uid };
}

/** Read current local identity, following only a recorded provider-confirmed move. */
async function currentProjection(client: PoolClient, accountId:string,id:string):Promise<GraphLocationSnapshot|null> {
  const result=await client.query<GraphLocationSnapshot>(
    `SELECT m.id,m.provider_message_id,m.folder,m.synced_at::text AS synced_at FROM messages m
      WHERE m.account_id=$1 AND m.provider_message_id=$2
     UNION
     SELECT m.id,m.provider_message_id,m.folder,m.synced_at::text AS synced_at
      FROM graph_mail_move_receipts r JOIN messages m ON m.id=r.message_row_id
      WHERE r.account_id=$1 AND r.old_provider_message_id=$2 AND m.account_id=$1
     LIMIT 2`, [accountId,id],
  );
  if(result.rows.length>1) throw new Error('Ambiguous local Graph move receipt');
  return result.rows[0]??null;
}

/** Apply a page location only if it is current or its pre-request snapshot is still owned. */
export async function admitGraphDeltaLocation(client:PoolClient,input:{
  accountId:string;connectionId:string;folderPath:string;messageId:string;checks:GraphLocationChecks;
}):Promise<boolean> {
  const current=await currentProjection(client,input.accountId,input.messageId);
  if(!current || (current.provider_message_id===input.messageId && current.folder===input.folderPath)) return true;
  const checked=input.checks.get(input.messageId);
  if(!checked || !sameGraphLocation(checked,current)) return false;
  return (await projectGraphMove(client,{
    accountId:input.accountId,connectionId:input.connectionId,rowId:current.id,
    sourceId:current.provider_message_id,targetId:input.messageId,targetPath:input.folderPath,
  })).moved;
}

/**
 * Hydrate unknown sparse rows and verify conflicting locations outside transactions.
 * Complete normal pages add no message-by-message HTTP calls. A stale source page
 * cannot resurrect a successful move; a genuine move back is checked with Graph.
 */
export async function prepareGraphDeltaPage(api:GraphApiOptions,input:{
  accountId:string;folderPath:string;remoteFolderId:string;messages:readonly GraphMessage[];
}):Promise<{messages:GraphMessage[];checks:GraphLocationChecks}> {
  const ids=input.messages.filter(m=>!m['@removed']).map(m=>m.id);
  if(!ids.length) return {messages:[...input.messages],checks:new Map()};
  const rows=await query<GraphLocationSnapshot & { requested_id:string }>(
    `SELECT m.provider_message_id AS requested_id,m.id,m.provider_message_id,m.folder,m.synced_at::text AS synced_at,
         NOT (m.message_id IS NULL AND (m.subject IS NULL OR m.subject='(no subject)') AND COALESCE(m.snippet,'')='') AS has_envelope
       FROM messages m WHERE m.account_id=$1 AND m.provider_message_id=ANY($2::text[])
     UNION
     SELECT r.old_provider_message_id,m.id,m.provider_message_id,m.folder,m.synced_at::text AS synced_at,
         NOT (m.message_id IS NULL AND (m.subject IS NULL OR m.subject='(no subject)') AND COALESCE(m.snippet,'')='') AS has_envelope
       FROM graph_mail_move_receipts r JOIN messages m ON m.id=r.message_row_id
       WHERE r.account_id=$1 AND m.account_id=$1 AND r.old_provider_message_id=ANY($2::text[])`,
    [input.accountId,ids],
  );
  const known=new Map<string,GraphLocationSnapshot>();
  for(const row of rows.rows){
    const previous=known.get(row.requested_id);
    if(previous && previous.id!==row.id) throw new Error('Conflicting Graph source projections');
    known.set(row.requested_id,row);
  }
  const messages:GraphMessage[]=[];
  const checks=new Map<string,GraphLocationSnapshot>();
  for(const event of input.messages){
    if(event['@removed']){messages.push(event);continue;}
    const current=known.get(event.id);
    const conflicting=!!current && (current.provider_message_id!==event.id || current.folder!==input.folderPath);
    const needsHydration=(!current || current.has_envelope===false) && !graphHasEnvelope(event);
    let message=event;
    if(conflicting || needsHydration){
      try{
        message=await graphGet<GraphMessage>(api,graphUrl(`/me/messages/${encodeURIComponent(event.id)}`,{$select:GRAPH_MESSAGE_SELECT}));
      }catch(error){
        if(error instanceof GraphApiError && error.status===404 && conflicting) continue;
        if(error instanceof GraphApiError && error.status===404){
          throw new GraphApiError({code:'UPSTREAM_UNAVAILABLE',status:503,retryable:true,message:'A new Graph delta item is not readable yet'});
        }
        throw error;
      }
      if(!message || !message.id || !message.parentFolderId) throw new Error('Invalid Graph message snapshot');
      if(message.parentFolderId!==input.remoteFolderId) continue;
      if(message.id!==event.id) throw new Error('Graph snapshot has a different physical identity');
      // Empty subject/preview/RFC Message-ID values are legal in a hydrated item.
      // The identity and folder checks above, not display content, admit it.
      if(current) checks.set(event.id,current);
    }
    if(message.parentFolderId && message.parentFolderId!==input.remoteFolderId) continue;
    messages.push(message);
  }
  return {messages,checks};
}
