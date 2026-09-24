import { withTransaction } from './db.js';
import { recordCalendarDeletionFence } from './calendarCollectionFence.js';
import { ensureGoogleCalendarCollection } from './providers/google/googleCalendarSync.js';
import { ensureGraphCalendarCollection } from './providers/microsoft/graphCalendarSync.js';
import type { CalendarCollectionMutationValue } from './calendarCollectionMutation.js';
import type { PoolClient } from 'pg';

export interface CalendarCollectionProjectionInput {
  operationId: string; userId: string; accountId: string; connectionId: string;
  value: CalendarCollectionMutationValue;
}
export interface CalendarCollectionProjectionResult { state: 'projected' | 'pending'; collectionId: string | null; localCalendarId: string | null; }

/** Persist the recovery obligation before touching a local projection. */
async function receipt(client: PoolClient, input: CalendarCollectionProjectionInput) {
  await client.query(`INSERT INTO calendar_collection_projection_receipts
    (operation_id,user_id,account_id,connection_id,action,remote_calendar_id)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (operation_id) DO NOTHING`,
  [input.operationId,input.userId,input.accountId,input.connectionId,input.value.action,input.value.remoteCalendarId]);
}

async function linked(client: PoolClient, input: CalendarCollectionProjectionInput) {
  const row = await client.query<{ id: string; local_calendar_id: string | null }>(`SELECT id,local_calendar_id FROM integration_collections
    WHERE user_id=$1 AND connection_id=$2 AND kind='calendar' AND remote_id=$3`, [input.userId,input.connectionId,input.value.remoteCalendarId]);
  return row.rows[0] ?? null;
}

/** Idempotently project a confirmed remote result. The caller returns pending if this throws. */
export async function projectCalendarCollection(input: CalendarCollectionProjectionInput): Promise<CalendarCollectionProjectionResult> {
  try {
    return await withTransaction(async client => {
      await receipt(client,input);
      if (input.value.action === 'delete') {
        await recordCalendarDeletionFence(client, { userId: input.userId, connectionId: input.connectionId, remoteCalendarId: input.value.remoteCalendarId, operationId: input.operationId });
        const current = await linked(client,input);
        // Snapshot the local ids before cleanup for an operator/recovery audit. Fence
        // precedes every destructive statement, so stale discovery cannot recreate it.
        await client.query(`UPDATE calendar_collection_projection_receipts SET collection_id=$2, local_calendar_id=$3 WHERE operation_id=$1`, [input.operationId,current?.id ?? null,current?.local_calendar_id ?? null]);
        if (current) {
          await client.query(`UPDATE integration_collections SET enabled=false, local_calendar_id=NULL, updated_at=NOW() WHERE id=$1`, [current.id]);
          // Calendar event/sync-change/occurrence foreign keys cascade; deleting the
          // projection prevents a phantom calendar without treating it as remote IO.
          if (current.local_calendar_id) await client.query(`DELETE FROM calendars WHERE id=$1 AND user_id=$2 AND owner_user_id=$2`, [current.local_calendar_id,input.userId]);
        }
        await client.query(`UPDATE calendar_collection_projection_receipts SET state='projected', projected_at=NOW() WHERE operation_id=$1`, [input.operationId]);
        return { state: 'projected', collectionId: current?.id ?? null, localCalendarId: current?.local_calendar_id ?? null };
      }
      // A pre-existing discovery projection retains its own access preference on replay.
      // A newly created collection starts read-only: remote creation must not enable
      // event write-back merely because the provider says this owner may write.
      const before = await linked(client,input);
      if (input.value.provider === 'google') {
        await ensureGoogleCalendarCollection(client,{ userId:input.userId, connectionId:input.connectionId, entry:{ id:input.value.remoteCalendarId, summary:input.value.name ?? input.value.remoteCalendarId, accessRole:'owner' } });
      } else {
        await ensureGraphCalendarCollection(client,{ userId:input.userId, connectionId:input.connectionId, entry:{ id:input.value.remoteCalendarId, name:input.value.name ?? input.value.remoteCalendarId, canEdit:true, isDefaultCalendar:false, owner:null } });
      }
      const current = await linked(client,input);
      if (!before && current) await client.query("UPDATE integration_collections SET user_access='read_only', updated_at=NOW() WHERE id=$1", [current.id]);
      if (!current?.local_calendar_id) throw new Error('Confirmed calendar did not receive a local projection');
      await client.query(`UPDATE calendar_collection_projection_receipts SET state='projected', collection_id=$2, local_calendar_id=$3, projected_at=NOW() WHERE operation_id=$1`, [input.operationId,current.id,current.local_calendar_id]);
      return { state:'projected',collectionId:current.id,localCalendarId:current.local_calendar_id };
    });
  } catch {
    return { state:'pending',collectionId:null,localCalendarId:null };
  }
}
