import { resolveGraphMessageIdentity } from './providers/microsoft/graphLegacyMessageBindings.js';
import { pluginRegistry } from '../plugins/registry.js';
import { populatedMessageSql, visiblePhysicalMessageSql } from './messageVisibility.js';
import { publishMailStateChanged } from './mailStateEvents.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from './db.js';
import type { EmailAccountRow } from './imapManager.js';
import type { ProviderAdapterOutcome, ProviderMutationStatus } from './providerMutationService.js';
import { graphFlagMutationAdapter } from './providers/microsoft/graphMailMutations.js';
import { gmailFlagMutationAdapter } from './providers/google/gmailMailMutations.js';
import { classifyImapFlagFailure } from './providers/imapFlagMutation.js';
import { graphGet } from './providers/microsoft/graphApiClient.js';
import { googleApiFetch } from './providers/google/googleApiClient.js';
import { googleConfigFromEnv, microsoftConfigFromEnv } from './providerAuthService.js';
import { immutableIdsEnabled } from './providers/microsoft/graphMessageIdType.js';
import type { ImapFlagPort } from './providerMailFlagWrite.js';
export interface MailFlagOutcome {
    status: ProviderMutationStatus;
    code?: string;
}
interface Identity {
    accountId: string;
    userId: string;
    transport: string;
    transportGeneration: string;
    connection: string | null;
    providerId: string | null;
    uid: string;
    folder: string;
    uidValidity: string | null;
}
interface MessageState {
    id: string;
    account_id: string;
    user_id: string;
    identity: Identity;
    is_read: boolean;
    is_starred: boolean;
    is_deleted: boolean;
    account_enabled: boolean;
    connection_status: string | null;
    read_changed_at: Date | null;
    star_changed_at: Date | null;
}
interface Intent {
    message_id: string;
    account_id: string;
    user_id: string;
    flag: string;
    value: boolean;
    generation: string;
    identity: Identity;
    status: string;
    lease_token: string | null;
    lease_valid?: boolean;
}
const STATE_SQL = `SELECT m.id, m.account_id, a.user_id, a.enabled AS account_enabled, pc.status AS connection_status, m.is_read,m.is_starred,m.is_deleted,
 m.read_changed_at,m.star_changed_at,
 jsonb_build_object('accountId',a.id,'userId',a.user_id,'transport',COALESCE(a.mail_transport,'imap_smtp'),
 'transportGeneration',a.transport_generation::text,'connection',a.provider_connection_id,
 'providerId',m.provider_message_id,'uid',m.uid::text,'folder',m.folder,'uidValidity',f.uid_validity::text) AS identity
 FROM messages m JOIN email_accounts a ON a.id=m.account_id
 LEFT JOIN folders f ON f.account_id=m.account_id AND f.path=m.folder
 LEFT JOIN provider_connections pc ON pc.id=a.provider_connection_id AND pc.user_id=a.user_id`;
export async function deferMailFlagReadback(messageId: string, client?: PoolClient): Promise<void> {
    const sql = `INSERT INTO mail_flag_readbacks(message_id,identity,next_attempt_at)
    SELECT id,identity,NOW()+INTERVAL '31 seconds' FROM (${STATE_SQL} WHERE m.id=$1) snapshot
    ON CONFLICT(message_id) DO UPDATE SET generation=mail_flag_readbacks.generation+1,identity=EXCLUDED.identity`;
    if (client)
        await client.query(sql, [messageId]);
    else
        await query(sql, [messageId]);
}
export interface MailFlagIntentInput {
    userId: string;
    accountId: string;
    messageId: string;
    flag: string;
    value: boolean;
}
/** Persist the complete batch before any provider call can start. Account locks
 * serialize canonical-alias batches without holding a lock across network I/O. */
export async function enqueueMailFlagIntents(inputs: readonly MailFlagIntentInput[]): Promise<Array<Intent | null>> {
    if (inputs.some(input => !['\\Seen', '\\Flagged'].includes(input.flag) || typeof input.value !== 'boolean')) {
        throw new Error('Invalid mail flag intent');
    }
    if (!inputs.length) return [];
    return withTransaction(async client => {
        const accounts = [...new Set(inputs.map(input => JSON.stringify([input.userId, input.accountId])))].sort();
        for (const account of accounts) {
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`mail-flag-enqueue:${account}`]);
        }
        const intents: Array<Intent | null> = [];
        for (const input of inputs) intents.push(await enqueueMailFlagIntentInTransaction(client, input));
        // An old alias and its canonical row can both be requested. Their one
        // physical operation is represented by the final generation for both IDs.
        const latest = new Map(intents.filter((intent): intent is Intent => intent !== null)
            .map(intent => [`${intent.message_id}:${intent.flag}`, intent]));
        return intents.map(intent => intent ? latest.get(`${intent.message_id}:${intent.flag}`) ?? intent : null);
    });
}
/** Every explicit click reserves a new generation, including same-state clicks. */
export async function enqueueMailFlagIntent(input: MailFlagIntentInput): Promise<Intent | null> {
    return (await enqueueMailFlagIntents([input]))[0] ?? null;
}
async function enqueueMailFlagIntentInTransaction(client: PoolClient, input: MailFlagIntentInput): Promise<Intent | null> {
    const candidate = (await client.query<MessageState>(`${STATE_SQL} WHERE m.id=$1 AND a.id=$2 AND a.user_id=$3`,
        [input.messageId, input.accountId, input.userId])).rows[0];
    if (!candidate || candidate.is_deleted || !candidate.account_enabled
        || (candidate.identity.connection && candidate.connection_status !== 'active')) return null;
    let messageId = candidate.id;
    let providerId = candidate.identity.providerId;
    if (candidate.identity.transport === 'microsoft_graph' && !providerId) {
        const resolved = await resolveGraphMessageIdentity(client, {
            messageId, accountId: input.accountId,
            connectionId: candidate.identity.connection, directProviderMessageId: null,
        });
        if (resolved.kind !== 'resolved') return null;
        messageId = resolved.canonicalMessageId;
        providerId = resolved.providerMessageId;
    }
    // Lock only the canonical physical copy: locking a legacy alias first
    // would reverse the provider ingest's canonical/binding lock order.
    const state = (await client.query<MessageState>(`${STATE_SQL} WHERE m.id=$1 AND a.id=$2 AND a.user_id=$3 FOR NO KEY UPDATE OF m FOR SHARE OF a`,
        [messageId, input.accountId, input.userId])).rows[0];
    if (!state || state.is_deleted || !state.account_enabled
        || (state.identity.connection && state.connection_status !== 'active')
        || state.identity.connection !== candidate.identity.connection
        || state.identity.transportGeneration !== candidate.identity.transportGeneration
        || state.identity.providerId !== providerId) return null;
    const result = await client.query<Intent>(`INSERT INTO mail_flag_intents(message_id,flag,user_id,account_id,value,identity)
  VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(message_id,flag) DO UPDATE SET
  generation=mail_flag_intents.generation+1,value=EXCLUDED.value,identity=EXCLUDED.identity,
  status='pending',code=NULL,next_attempt_at=NOW(),updated_at=NOW() RETURNING *`,
        [state.id, input.flag, input.userId, input.accountId, input.value, JSON.stringify(state.identity)]);
    // Authoritative flags change only after confirmation or provider readback.
    return result.rows[0];
}
export interface MailFlagWorkerPort extends ImapFlagPort {
    readMessageFlags?(account: EmailAccountRow, uid: number | string, folder: string, expectedUidValidity: number | string | null): Promise<{
        isRead: boolean;
        isStarred: boolean;
    } | null>;
    broadcast?(event: {
        type: string;
        accountId: string;
        changes?: Array<{
            id: string;
            is_read: boolean;
            is_starred: boolean;
        }>;
    }, userId?: string): void;
}
export interface MailFlagPorts {
    shouldStop?: () => boolean;
    manager: MailFlagWorkerPort;
    write?: (state: MessageState, account: EmailAccountRow, intent: Intent) => Promise<ProviderAdapterOutcome<void>>;
    read?: (state: MessageState, account: EmailAccountRow) => Promise<{
        isRead: boolean;
        isStarred: boolean;
    } | null>;
}
async function writeFlag(state: MessageState, account: EmailAccountRow, intent: Intent, ports: MailFlagPorts): Promise<ProviderAdapterOutcome<void>> {
    if (ports.write)
        return ports.write(state, account, intent);
    const payload = { providerMessageId: state.identity.providerId ?? '', flag: intent.flag, value: intent.value, intentAt: String(intent.generation) };
    const context = { operationId: `${intent.message_id}:${intent.generation}`, signal: AbortSignal.timeout(20000) };
    if (state.identity.transport === 'microsoft_graph' || state.identity.transport === 'gmail_api') {
        if (!state.identity.connection)
            return { status: 'permanent', code: 'PROVIDER_AUTH_REQUIRED' };
        if (!state.identity.providerId)
            return { status: 'permanent', code: 'RESOURCE_NOT_FOUND' };
        if (state.identity.transport === 'microsoft_graph')
            return graphFlagMutationAdapter({ api: { userId: state.user_id, connectionId: state.identity.connection, config: microsoftConfigFromEnv(), immutableIds: await immutableIdsEnabled(state.identity.connection) } }).perform(payload, context);
        return gmailFlagMutationAdapter({ api: { userId: state.user_id, connectionId: state.identity.connection, config: googleConfigFromEnv() } }).perform(payload, context);
    }
    try {
        await ports.manager.setFlag(account, state.identity.uid, state.identity.folder, intent.flag, intent.value, state.identity.uidValidity);
        return { status: 'committed' };
    }
    catch (error) {
        return classifyImapFlagFailure(error);
    }
}
async function readFlags(state: MessageState, account: EmailAccountRow, ports: MailFlagPorts): Promise<{
    isRead: boolean;
    isStarred: boolean;
} | null> {
    if (ports.read)
        return ports.read(state, account);
    const { identity } = state;
    if (identity.transport === 'microsoft_graph') {
        if (!identity.connection || !identity.providerId)
            throw new Error('Missing provider identity');
        const result = await graphGet<{
            id?: string;
            isRead: boolean;
            flag?: {
                flagStatus?: string;
            };
        }>({ userId: state.user_id, connectionId: identity.connection, immutableIds: await immutableIdsEnabled(identity.connection) }, `/me/messages/${encodeURIComponent(identity.providerId)}?$select=id,isRead,flag`);
        if (result?.id !== identity.providerId || typeof result.isRead !== 'boolean' || !result.flag || !['flagged', 'notFlagged', 'complete'].includes(result.flag.flagStatus ?? ''))
            throw new Error('Invalid Graph flag readback');
        return { isRead: result.isRead, isStarred: result.flag.flagStatus === 'flagged' };
    }
    if (identity.transport === 'gmail_api') {
        if (!identity.connection || !identity.providerId)
            throw new Error('Missing provider identity');
        const result = await googleApiFetch<{
            id?: string;
            labelIds?: string[];
        }>({ userId: state.user_id, connectionId: identity.connection, config: googleConfigFromEnv() }, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(identity.providerId)}?format=minimal`);
        if (result?.id !== identity.providerId || !Array.isArray(result.labelIds) || !result.labelIds.every(label => typeof label === 'string'))
            throw new Error('Invalid Gmail flag readback');
        return { isRead: !result.labelIds.includes('UNREAD'), isStarred: result.labelIds.includes('STARRED') };
    }
    if (!ports.manager.readMessageFlags)
        throw new Error('IMAP flag reader unavailable');
    return ports.manager.readMessageFlags(account, identity.uid, identity.folder, identity.uidValidity);
}
/** Only project provider-confirmed/observed flag labels; preserve unrelated Gmail labels. */
async function projectGmailFlagLabels(client: PoolClient, state: MessageState, read: boolean | null, starred: boolean | null): Promise<void> {
    if (state.identity.transport !== 'gmail_api') return;
    for (const [label, enabled] of [['UNREAD', read === null ? null : !read], ['STARRED', starred]] as const) {
        if (enabled === null) continue;
        await client.query(`UPDATE messages SET provider_labels=array_remove(COALESCE(provider_labels,'{}'::text[]),$2)
          || CASE WHEN $3 THEN ARRAY[$2::text] ELSE '{}'::text[] END WHERE id=$1`, [state.id,label,enabled]);
        if (enabled) await client.query(`INSERT INTO message_labels(message_id,account_id,label_id,folder_path)
          VALUES($1,$2,$3,NULL) ON CONFLICT(message_id,label_id) DO NOTHING`, [state.id,state.account_id,label]);
        else await client.query('DELETE FROM message_labels WHERE message_id=$1 AND account_id=$2 AND label_id=$3', [state.id,state.account_id,label]);
    }
}
/** Folder copies can share a provider-wide flag, but RFC identity alone never
 * authorizes writing another copy. Observe each sibling independently instead. */
async function deferFlagSiblings(client: PoolClient, state: MessageState): Promise<void> {
    const siblings = await client.query<{id: string}>(`SELECT m.id FROM messages m
      WHERE m.account_id=$1 AND m.id<>$2 AND m.is_deleted=false
        AND NULLIF(btrim(m.message_id),'')=(SELECT NULLIF(btrim(message_id),'') FROM messages WHERE id=$2)
        AND (${visiblePhysicalMessageSql})
        AND ($3='imap_smtp' OR NULLIF(btrim(m.provider_message_id),'') IS NOT NULL) ORDER BY m.id`, [state.account_id,state.id,state.identity.transport]);
    for (const sibling of siblings.rows) await deferMailFlagReadback(sibling.id, client);
}
function sameIdentity(a: Identity, b: Identity): boolean {
    return Object.keys(a).every(key => a[key as keyof Identity] === b[key as keyof Identity]);
}
async function publish(state: MessageState, ports: MailFlagPorts, account: EmailAccountRow): Promise<void> {
    // Recount under the same account/folder scope. Reconciliation may move either direction.
    await query(`UPDATE folders f SET unread_count=(SELECT COUNT(*) FROM messages m WHERE m.account_id=f.account_id AND (m.folder=f.path OR EXISTS(SELECT 1 FROM message_labels ml WHERE ml.message_id=m.id AND ml.folder_path=f.path)) AND m.is_deleted=false AND m.is_read=false AND (${visiblePhysicalMessageSql}) AND (${populatedMessageSql}) AND (m.is_archived=false OR f.path<>'INBOX')) WHERE f.account_id=$1 AND (f.path=$2 OR EXISTS(SELECT 1 FROM message_labels ml WHERE ml.message_id=$3 AND ml.account_id=$1 AND ml.folder_path=f.path))`, [state.account_id, state.identity.folder, state.id]);
    publishMailStateChanged({ userId: state.user_id, accountId: state.account_id });
    ports.manager.broadcast?.({ type: 'message_flags', accountId: state.account_id, changes: [{ id: state.id, is_read: state.is_read, is_starred: state.is_starred }] }, state.user_id);
    ports.manager.broadcast?.({ type: 'sync_complete', accountId: state.account_id }, state.user_id);
    ports.manager.broadcast?.({ type: 'folders_synced', accountId: state.account_id }, state.user_id);
    if (ports.manager.pluginFacade) await pluginRegistry.runHook('sectionsChanged', {
        mgr: ports.manager.pluginFacade, account, changedCount: 1,
    });
}
export async function processMailFlagIntent(messageId: string, flag: string, ports: MailFlagPorts, expectedGeneration?: string): Promise<MailFlagOutcome> {
    const token = randomUUID();
    const claim = (await query<Intent>(`UPDATE mail_flag_intents SET lease_token=$3,lease_until=NOW()+INTERVAL '90 seconds',
    status=CASE WHEN status='writing' THEN 'readback' ELSE status END
    WHERE message_id=$1 AND flag=$2 AND ($4::bigint IS NULL OR generation=$4) AND status IN ('pending','writing','readback')
    AND next_attempt_at<=NOW() AND (lease_until IS NULL OR lease_until<NOW()) RETURNING *`, [messageId, flag, token, expectedGeneration ?? null])).rows[0];
    if (!claim)
        return { status: 'pending' };
    const state = (await query<MessageState>(`${STATE_SQL} WHERE m.id=$1 AND a.user_id=$2`, [messageId, claim.user_id])).rows[0];
    const account = (await query<EmailAccountRow>('SELECT * FROM email_accounts WHERE id=$1 AND user_id=$2 AND enabled=true', [claim.account_id, claim.user_id])).rows[0];
    let outcome: ProviderAdapterOutcome<void> = { status: 'permanent', code: 'MAIL_IDENTITY_CHANGED' };
    let observed: {
        isRead: boolean;
        isStarred: boolean;
    } | null = null;
    let reading = claim.status === 'readback';
    if (state && account && state.account_enabled && (!state.identity.connection || state.connection_status === 'active') && state.account_id === claim.account_id && state.user_id === claim.user_id && !state.is_deleted && sameIdentity(state.identity, claim.identity)) {
        try {
            if (reading)
                observed = await readFlags(state, account, ports);
            else {
                const owned = await query(`UPDATE mail_flag_intents SET status='writing' WHERE message_id=$1 AND flag=$2 AND generation=$3 AND lease_token=$4 AND lease_until>NOW()`, [messageId, flag, claim.generation, token]);
                if (!owned.rowCount) {
                    await query('UPDATE mail_flag_intents SET lease_token=NULL,lease_until=NULL WHERE message_id=$1 AND flag=$2 AND lease_token=$3', [messageId, flag, token]);
                    return { status: 'pending' };
                }
                outcome = await writeFlag(state, account, claim, ports);
                reading = outcome.status === 'outcome_unknown';
            }
        }
        catch (error) {
            console.warn('Mail flag transport failed:', error instanceof Error ? error.message : String(error));
            outcome = { status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' };
            reading = true;
        }
    }
    const applied = await withTransaction(async (client) => {
        // Serialize with enqueue and re-check the physical identity after network I/O.
        const current = (await client.query<MessageState>(`${STATE_SQL} WHERE m.id=$1 FOR NO KEY UPDATE OF m FOR SHARE OF a`, [messageId])).rows[0];
        const owned = (await client.query<Intent>('SELECT *,lease_until>NOW() AS lease_valid FROM mail_flag_intents WHERE message_id=$1 AND flag=$2 FOR UPDATE', [messageId, flag])).rows[0];
        if (!owned || owned.lease_token !== token || !owned.lease_valid)
            return null;
        if (owned.generation !== claim.generation) {
            await client.query('UPDATE mail_flag_intents SET lease_token=NULL,lease_until=NULL WHERE message_id=$1 AND flag=$2 AND lease_token=$3', [messageId, flag, token]);
            return null;
        }
        const valid = current && state && current.account_enabled && (!current.identity.connection || current.connection_status === 'active') && current.account_id === claim.account_id && current.user_id === claim.user_id && !current.is_deleted && sameIdentity(current.identity, claim.identity);
        if (!valid) {
            outcome = { status: 'permanent', code: 'MAIL_IDENTITY_CHANGED' };
            observed = null;
            reading = false;
        }
        const status = observed ? 'reconciled' : reading ? 'readback' : outcome.status === 'committed' ? 'confirmed' : outcome.status === 'retryable' ? 'pending' : 'failed';
        const retrySeconds = outcome.status === 'retryable' && Number.isFinite(outcome.retryAfterSeconds)
            ? Math.min(86400, Math.max(30, Math.ceil(outcome.retryAfterSeconds ?? 30))) : 30;
        await client.query(`UPDATE mail_flag_intents SET status=$5,code=$6,lease_token=NULL,lease_until=NULL,next_attempt_at=NOW()+make_interval(secs=>$7),updated_at=NOW()
      WHERE message_id=$1 AND flag=$2 AND generation=$3 AND lease_token=$4`, [messageId, flag, claim.generation, token, status, observed ? 'RECONCILED_PROVIDER_STATE' : 'code' in outcome ? outcome.code : null, retrySeconds]);
        if (valid && (observed || status === 'confirmed')) {
            const value = observed ? (flag === '\\Seen' ? observed.isRead : observed.isStarred) : claim.value;
            const column = flag === '\\Seen' ? 'is_read' : 'is_starred';
            const changed = flag === '\\Seen' ? 'read_changed_at' : 'star_changed_at';
            await client.query(`UPDATE messages SET ${column}=$2,${changed}=NOW() WHERE id=$1`, [messageId, value]);
            current[column] = value;
            await projectGmailFlagLabels(client, current, flag === '\\Seen' ? value : null, flag === '\\Flagged' ? value : null);
            if (status === 'confirmed') await deferFlagSiblings(client, current);
            return current;
        }
        return null;
    });
    if (applied && account)
        await publish(applied, ports, account);
    if (observed)
        return applied ? { status: 'outcome_unknown', code: 'RECONCILED_PROVIDER_STATE' } : { status: 'pending', code: 'SUPERSEDED' };
    // A superseded response never acknowledges the newest intent.
    if (outcome.status === 'committed')
        return applied ? { status: 'confirmed' } : { status: 'pending', code: 'SUPERSEDED' };
    return { status: outcome.status === 'retryable' ? 'retryable' : outcome.status === 'permanent' ? 'permanent' : 'outcome_unknown', ...('code' in outcome ? { code: outcome.code } : {}) };
}
/** Bounded, cursor-independent readback: old IMAP UIDs and empty native deltas are covered alike. */
export async function drainMailFlagReadbacks(ports: MailFlagPorts, limit = 25, accountId?: string): Promise<void> {
    const candidates = await query<{
        message_id: string;
    }>(`SELECT message_id FROM mail_flag_readbacks WHERE ($2::uuid IS NULL OR message_id IN (SELECT id FROM messages WHERE account_id=$2)) AND next_attempt_at<=NOW() AND (lease_until IS NULL OR lease_until<NOW()) ORDER BY next_attempt_at LIMIT $1`, [limit, accountId ?? null]);
    for (const candidate of candidates.rows) {
        if (ports.shouldStop?.()) break;
        const token = randomUUID();
        const claim = (await query<{
            generation: string;
            identity: Identity | null;
        }>(`UPDATE mail_flag_readbacks SET lease_token=$2,lease_until=NOW()+INTERVAL '90 seconds' WHERE message_id=$1 AND (lease_until IS NULL OR lease_until<NOW()) RETURNING generation,identity`, [candidate.message_id, token])).rows[0];
        if (!claim)
            continue;
        try {
            const state = (await query<MessageState>(`${STATE_SQL} WHERE m.id=$1`, [candidate.message_id])).rows[0];
            const account = state ? (await query<EmailAccountRow>('SELECT * FROM email_accounts WHERE id=$1 AND user_id=$2 AND enabled=true', [state.account_id, state.user_id])).rows[0] : null;
            if (!state || !account || !state.account_enabled || (state.identity.connection && state.connection_status !== 'active'))
                throw new Error('Mail readback account unavailable');
            if (claim.identity && !sameIdentity(state.identity, claim.identity)) {
                await query('DELETE FROM mail_flag_readbacks WHERE message_id=$1 AND generation=$2 AND lease_token=$3', [candidate.message_id, claim.generation, token]);
                continue;
            }
            const flags = await readFlags(state, account, ports);
            if (!flags)
                throw new Error('Mail readback identity not found');
            const applied = await withTransaction(async (client) => {
                const current = (await client.query<MessageState>(`${STATE_SQL} WHERE m.id=$1 FOR NO KEY UPDATE OF m FOR SHARE OF a`, [state.id])).rows[0];
                const owned = (await client.query<{
                    generation: string;
                    lease_token: string;
                    lease_valid: boolean;
                }>('SELECT *,lease_until>NOW() AS lease_valid FROM mail_flag_readbacks WHERE message_id=$1 FOR UPDATE', [state.id])).rows[0];
                if (!owned || owned.lease_token !== token || !owned.lease_valid || owned.generation !== claim.generation || !current || !current.account_enabled || (current.identity.connection && current.connection_status !== 'active') || current.account_id !== state.account_id || current.user_id !== state.user_id || !sameIdentity(current.identity, state.identity))
                    return null;
                const active = (await client.query<{
                    flag: string;
                }>(`SELECT flag FROM mail_flag_intents WHERE message_id=$1 AND status IN ('pending','writing','readback')`, [state.id])).rows;
                const blocked = (flag: string, at: Date | null, previous: Date | null) => active.some(row => row.flag === flag) || at?.getTime() !== previous?.getTime() || !!(at && at.getTime() > Date.now() - 30000);
                const readBlocked = blocked('\\Seen', current.read_changed_at, state.read_changed_at);
                const starBlocked = blocked('\\Flagged', current.star_changed_at, state.star_changed_at);
                await client.query('UPDATE messages SET is_read=$2,is_starred=$3 WHERE id=$1', [state.id, readBlocked ? current.is_read : flags.isRead, starBlocked ? current.is_starred : flags.isStarred]);
                if (!readBlocked)
                    current.is_read = flags.isRead;
                if (!starBlocked)
                    current.is_starred = flags.isStarred;
                await projectGmailFlagLabels(client, current, readBlocked ? null : flags.isRead, starBlocked ? null : flags.isStarred);
                if (!readBlocked && !starBlocked) {
                    await client.query('DELETE FROM mail_flag_readbacks WHERE message_id=$1 AND generation=$2 AND lease_token=$3', [state.id, claim.generation, token]);
                    await client.query(`UPDATE provider_operations SET status='cancelled',error_code='RECONCILED_PROVIDER_STATE',result=jsonb_build_object('reconciled',true,'historicalOutcome','unknown'),updated_at=NOW()
            WHERE resource_id=$1 AND user_id=$2 AND account_id=$3 AND resource_type='message' AND operation='update' AND payload->>'flag' IN ('\\Seen','\\Flagged') AND (connection_id IS NULL OR connection_id=$4) AND payload->>'providerMessageId' IS NOT DISTINCT FROM $5::text AND status IN ('pending','outcome_unknown','in_flight') AND (lease_expires_at IS NULL OR lease_expires_at<NOW())`, [state.id, state.user_id, state.account_id, state.identity.connection, state.identity.providerId]);
                }
                return current;
            });
            if (applied)
                await publish(applied, ports, account);
        }
        catch (error) {
            console.warn('Mail flag readback deferred:', error instanceof Error ? error.message : String(error));
        }
        finally {
            await query(`UPDATE mail_flag_readbacks SET lease_token=NULL,lease_until=NULL,next_attempt_at=NOW()+INTERVAL '30 seconds' WHERE message_id=$1 AND lease_token=$2`, [candidate.message_id, token]);
        }
    }
}
export async function drainMailFlagIntents(ports: MailFlagPorts, limit = 25, accountId?: string): Promise<void> {
    // A rolling upgrade may leave old journal rows after migration 0156 seeded its
    // first batch. Known flag operations are observations now, never old targets to replay.
    await query(`INSERT INTO mail_flag_readbacks(message_id,next_attempt_at)
      SELECT DISTINCT m.id,NOW() FROM provider_operations o
      JOIN messages m ON m.id=o.resource_id AND m.account_id=o.account_id
      JOIN email_accounts a ON a.id=m.account_id AND a.user_id=o.user_id
      WHERE o.resource_type='message' AND o.operation='update'
        AND o.payload->>'flag' IN (chr(92)||'Seen',chr(92)||'Flagged')
        AND (o.connection_id IS NULL OR o.connection_id=a.provider_connection_id)
        AND o.payload->>'providerMessageId' IS NOT DISTINCT FROM m.provider_message_id
        AND o.status IN ('pending','outcome_unknown','in_flight')
        AND (o.lease_expires_at IS NULL OR o.lease_expires_at<NOW())
        AND ($1::uuid IS NULL OR a.id=$1)
        AND NOT EXISTS(SELECT 1 FROM mail_flag_readbacks r WHERE r.message_id=m.id)
      LIMIT $2 ON CONFLICT DO NOTHING`, [accountId ?? null, limit]);

    const due = await query<{
        message_id: string;
        flag: string;
    }>(`SELECT message_id,flag FROM mail_flag_intents WHERE ($2::uuid IS NULL OR account_id=$2) AND status IN ('pending','writing','readback') AND next_attempt_at<=NOW() AND (lease_until IS NULL OR lease_until<NOW()) ORDER BY next_attempt_at LIMIT $1`, [limit, accountId ?? null]);
    for (const row of due.rows) {
        if (ports.shouldStop?.()) break;
        await processMailFlagIntent(row.message_id, row.flag, ports);
    }
    await drainMailFlagReadbacks(ports, limit, accountId);
}
export function createMailFlagWorker(ports: MailFlagPorts) {
    let stopped = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> | undefined;
    const tick = () => {
        if (stopped)
            return;
        running = drainMailFlagIntents({ ...ports, shouldStop: () => stopped }).catch(error => console.error('Mail flag worker failed:', error)).finally(() => {
            running = undefined;
            if (!stopped) {
                timer = setTimeout(tick, 15000);
                timer.unref();
            }
        });
    };
    return { start() { if (stopped) {
            stopped = false;
            tick();
        } }, async stop() { stopped = true; if (timer)
            clearTimeout(timer); await running; } };
}
