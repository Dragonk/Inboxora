import { readMailPrefetchLimit } from './mailPrefetchSettings.js';
import { pool } from './db.js';
import { googleConfigFromEnv, microsoftConfigFromEnv } from './providerAuthService.js';
import { fetchGmailMessageContent, collectGmailInlineImages, embedGmailInlineImages, localAttachmentsForGmail } from './providers/google/gmailMailBody.js';
import { fetchGraphMessageBody } from './providers/microsoft/graphMailBody.js';
import { immutableIdsEnabled } from './providers/microsoft/graphMessageIdType.js';
import { sanitizeEmail } from './emailSanitizer.js';
import { snippetFromBody } from './messageParser.js';
import { toAppError } from '../utils/errors.js';

export const MAX_PREFETCH_CACHE_BYTES = 2 * 1024 * 1024;
const active = new Set<string>();

export interface PrefetchAccount {
  id: string;
  user_id: string;
  mail_transport?: string | null;
  provider_connection_id?: string | null;
}
export interface PrefetchMessage {
  id: string; uid: number | string; folder: string; provider_message_id: string | null; row_version: number;
}
export interface PrefetchedBody {
  html: string | null; text: string | null; attachments?: unknown[]; gmailComplete?: boolean; graphComplete?: boolean;
}
export type BodyPrefetchReader = (message: PrefetchMessage) => Promise<PrefetchedBody | null>;
export function bodyPrefetchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MAIL_BODY_PREFETCH !== 'off';
}
export function prefetchRetrySeconds(error: unknown): number {
  const hint = Number((error as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds);
  return Number.isFinite(hint) && hint > 0 ? Math.max(60, hint) : 300;
}

/** Native body reads never invoke IMAP/SMTP or mark the provider message read. */
export async function readNativePrefetchBody(account: PrefetchAccount, message: PrefetchMessage): Promise<PrefetchedBody | null> {
  const connectionId = account.provider_connection_id;
  if (!connectionId || !message.provider_message_id) return null; // legacy binding is resolved on demand, not guessed
  if (account.mail_transport === 'gmail_api') {
    const api = { userId: account.user_id, connectionId, config: googleConfigFromEnv() };
    const content = await fetchGmailMessageContent(api, message.provider_message_id);
    if (content.complete === false) return null;
    if (Buffer.byteLength(content.html ?? '') + Buffer.byteLength(content.text ?? '') > MAX_PREFETCH_CACHE_BYTES) return null;
    let html = content.html;
    if (html && /\bcid:/i.test(html)) {
      const inline = await collectGmailInlineImages(api, message.provider_message_id, content.attachments, { maxImages: 3, maxBytes: 512 * 1024 });
      html = embedGmailInlineImages(html, inline);
    }
    return { html, text: content.text, attachments: localAttachmentsForGmail(content.attachments), gmailComplete: true };
  }
  if (account.mail_transport === 'microsoft_graph') {
    const body = await fetchGraphMessageBody({ userId: account.user_id, connectionId,
      config: microsoftConfigFromEnv(), immutableIds: await immutableIdsEnabled(connectionId) }, message.provider_message_id);
    if (!body) return null;
    // Do not fetch the attachment collection speculatively: Graph can include
    // contentBytes in it. The reader obtains attachments/CID data on demand.
    return body.contentType === 'html' ? { html: body.content, text: null, graphComplete: true } : { html: null, text: body.content, graphComplete: true };
  }
  return null;
}

/** Best-effort warming of the admin-configured visible window, at most two accounts
 * per process, one request stream per account across replicas. There is no
 * durable mailbox-wide queue: switching folders cannot enqueue the whole inbox. */
export async function prefetchVisibleBodies(account: PrefetchAccount, ids: string[], read: BodyPrefetchReader): Promise<void> {
  if (!bodyPrefetchEnabled() || active.has(account.id) || active.size >= 2) return;
  if (!ids.length) return;
  active.add(account.id);
  const client = await pool.connect().catch(error => { active.delete(account.id); throw error; });
  try {
    const limit = await readMailPrefetchLimit(client);
    if (limit === 0) return;
    const candidates = [...new Set(ids)].slice(0, limit);
    const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1), 147) AS ok', [`mail-body-prefetch:${account.id}`]);
    if (!lock.rows[0].ok) return;
    const transport = account.mail_transport || 'imap_smtp';
    const native = transport === 'gmail_api' || transport === 'microsoft_graph';
    const owned = await client.query(`SELECT 1 FROM email_accounts a
      WHERE a.id=$1 AND a.user_id=$2 AND a.enabled=true
        AND COALESCE(a.mail_transport,'imap_smtp')=$3
        AND a.provider_connection_id IS NOT DISTINCT FROM $4::uuid
        AND (a.body_prefetch_after IS NULL OR a.body_prefetch_after <= NOW())
        AND ($5::boolean=false OR EXISTS (SELECT 1 FROM provider_connections pc
          WHERE pc.id=a.provider_connection_id AND pc.user_id=a.user_id AND pc.status='active'))`,
    [account.id,account.user_id,transport,account.provider_connection_id ?? null,native]);
    if (!owned.rows.length) return;
    const messages = await client.query<PrefetchMessage>(`UPDATE messages SET body_prefetch_after=NOW()+INTERVAL '5 minutes'
      WHERE id IN (SELECT id FROM messages WHERE account_id=$1 AND id=ANY($2::uuid[]) AND is_deleted=false
        AND body_html IS NULL AND body_text IS NULL
        AND NOT (gmail_reader_body_complete AND gmail_attachment_metadata_complete)
        AND (body_prefetch_after IS NULL OR body_prefetch_after <= NOW())
        ORDER BY array_position($2::uuid[],id) LIMIT $3 FOR UPDATE SKIP LOCKED)
      RETURNING id,uid,folder,provider_message_id,row_version`, [account.id,candidates,limit]);
    // UPDATE ... RETURNING does not promise list order. Warm the first visible
    // messages first, rather than letting a larger batch reorder the reader's wait.
    const rank = new Map(candidates.map((id, index) => [id, index]));
    messages.rows.sort((a,b) => rank.get(a.id)! - rank.get(b.id)!);
    for (const message of messages.rows) {
      try {
        const body = await read(message);
        if (!body) continue;
        const clean = (s: string | null) => s === null ? null : s.replace(/\0/g,'');
        const html = body.html ? clean(sanitizeEmail(body.html)) : null;
        const text = clean(body.text);
        const attachments = body.attachments ? JSON.stringify(body.attachments) : null;
        if (Buffer.byteLength(html ?? '')+Buffer.byteLength(text ?? '')+Buffer.byteLength(attachments ?? '') > MAX_PREFETCH_CACHE_BYTES) continue;
        if (!html && !text && !body.gmailComplete) continue;
        // Fence late completion by tenant, provider binding and row version;
        // never overwrite a body a foreground reader has already populated.
        await client.query(`UPDATE messages m SET body_html=$1,body_text=$2,
          attachments=COALESCE($3::jsonb,m.attachments),
          graph_reader_body_complete=CASE WHEN $14 THEN true ELSE graph_reader_body_complete END,
          gmail_reader_body_complete=CASE WHEN $4 THEN true ELSE gmail_reader_body_complete END,
          gmail_attachment_metadata_complete=CASE WHEN $4 THEN true ELSE gmail_attachment_metadata_complete END,
          snippet=CASE WHEN $5<>'' THEN $5 ELSE m.snippet END
          FROM email_accounts a WHERE m.id=$6 AND m.account_id=a.id AND a.id=$7 AND a.user_id=$8
          AND a.enabled=true AND COALESCE(a.mail_transport,'imap_smtp')=$9
          AND a.provider_connection_id IS NOT DISTINCT FROM $10::uuid
          AND m.provider_message_id IS NOT DISTINCT FROM $11::text AND m.row_version=$12
          AND m.body_html IS NULL AND m.body_text IS NULL AND m.is_deleted=false
          AND ($13::boolean=false OR EXISTS (SELECT 1 FROM provider_connections pc
            WHERE pc.id=a.provider_connection_id AND pc.user_id=a.user_id AND pc.status='active'))`,
        [html,text,attachments,body.gmailComplete===true,snippetFromBody(text ?? '',html),message.id,account.id,account.user_id,
          transport,account.provider_connection_id ?? null,message.provider_message_id,message.row_version,native,body.graphComplete===true]);
      } catch (error) {
        await client.query('UPDATE email_accounts SET body_prefetch_after=NOW()+$3*INTERVAL \'1 second\' WHERE id=$1 AND user_id=$2',
          [account.id,account.user_id,prefetchRetrySeconds(error)]);
        console.warn('Visible body prefetch paused:', toAppError(error).code ?? 'READ_FAILED');
        break;
      }
    }
  } finally {
    active.delete(account.id);
    client.release(true); // release the account advisory lock even after an error
  }
}
