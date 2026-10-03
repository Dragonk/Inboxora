import { createHash, randomUUID } from 'node:crypto';
import { validUndoSendSeconds } from '../utils/undoSend.js';
import { parseMailbox } from './composedMail.js';
import { query, withTransaction } from './db.js';
import type { DbClient } from './db.js';
import type { PreparedSend, SendExecutionOptions, SendExecutionResult, SendRequestBody } from './sendMail.js';

export type SendExecutor = (userId: string, payload: SendRequestBody, key: string | null,
  options?: SendExecutionOptions) => Promise<SendExecutionResult>;
export type ScheduledState = 'pending' | 'editing' | 'preparing' | 'sending' | 'sent' | 'partial' | 'failed' | 'uncertain' | 'cancelled' | 'dismissed';
export interface ScheduledSummary {
  id: string; accountId: string; subject: string; mode: 'undo' | 'schedule'; state: ScheduledState;
  scheduledAt: Date; timeZone: string; revision: number; errorCode: string | null;
  senderEmail?: string | null; to?: string[]; cc?: string[]; recipientCount?: number;
}
export interface ScheduledRow extends ScheduledSummary {
  user_id: string; payload: PreparedSend; lease_token: string | null; request_fingerprint: string; edit_fingerprint: string | null;
}
const SUMMARY = `id, account_id AS "accountId", subject, mode, state, scheduled_at AS "scheduledAt",
  time_zone AS "timeZone", revision, last_error_code AS "errorCode",
  COALESCE(payload->>'senderEmail', sent_metadata->>'senderEmail') AS "senderEmail",
  COALESCE(payload#>'{payload,to}', sent_metadata->'to', '[]'::jsonb) AS "to",
  COALESCE(payload#>'{payload,cc}', sent_metadata->'cc', '[]'::jsonb) AS "cc",
  CASE WHEN payload ? 'payload' THEN
    jsonb_array_length(COALESCE(payload#>'{payload,to}', '[]'::jsonb)) +
    jsonb_array_length(COALESCE(payload#>'{payload,cc}', '[]'::jsonb)) +
    jsonb_array_length(COALESCE(payload#>'{payload,bcc}', '[]'::jsonb))
  ELSE COALESCE((sent_metadata->>'recipientCount')::int, 0) END AS "recipientCount"`;
const DETAIL = `${SUMMARY}, user_id, payload, lease_token, request_fingerprint, edit_fingerprint`;
const MAX_ACTIVE = 100;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ADDRESS = /^[^\s<>@,;]+@[^\s<>@,;]+$/;
interface MergeBatchRow { id: string; request_fingerprint: string; item_ids: string[]; scheduled_at: Date }
export interface MergeReceipt { id: string; count: number; scheduledAt: Date; items: ScheduledSummary[] }

/** Expected user errors are safe to expose; infrastructure errors use normal middleware. */
export class ScheduledMailError extends Error {
  /** Preserve the public status and stable application error code. */
  constructor(public status: number, public code: string, message: string) { super(message); }
}
/** Raise a typed validation error without exposing infrastructure details. */
function invalid(message: string): never { throw new ScheduledMailError(400, 'SCHEDULE_INVALID', message); }
/** A distinct code lets clients localize an expired scheduling choice. */
function schedulePast(): never { throw new ScheduledMailError(400, 'SCHEDULE_PAST', 'Scheduled time must be in the future'); }
/** Check database wall time, including waits inside the final transactional write.
 * A failed post-write check rolls back before any worker can observe pending work.
 * Undo/Send now deliberately do not use this future-only scheduling guard.
 */
async function requireFutureWrite(client: DbClient, scheduledAt: Date): Promise<void> {
  const result = await client.query<{ future: boolean }>('SELECT $1::timestamptz > clock_timestamp() AS future', [scheduledAt]);
  if (!result.rows[0]?.future) schedulePast();
}
/** Validate the queue identifier before an owner-scoped database query. */
export function requireScheduledId(value: string): void {
  if (!UUID.test(value)) invalid('Invalid scheduled message id');
}
/** Require an explicit IANA zone; never reinterpret an instant in the server's zone. */
export function validateTimeZone(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 80) invalid('A valid time zone is required');
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
  catch { return invalid('Unknown time zone'); }
}
/** API clients submit UTC ISO instants. Calendar validity is checked by round-trip. */
export function validateScheduledAt(value: unknown, now = Date.now()): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    invalid('Scheduled time must be an explicit UTC ISO timestamp');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')) {
    invalid('Invalid calendar date');
  }
  if (date.getTime() <= now) schedulePast();
  return date;
}
/** Require a JSON object before reading queued-message fields. */
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('Message must be an object');
  return value as Record<string, unknown>;
}
/** Whitelist persisted fields; ordinary send validation remains authoritative. */
export function validateScheduledPayload(value: unknown): SendRequestBody {
  const input = record(value);
  if (typeof input.accountId !== 'string' || !UUID.test(input.accountId)) invalid('Invalid sending account');
  if (typeof input.body !== 'string' || typeof input.bodyIsHtml !== 'boolean') invalid('Message body and format are required');
  const out: Record<string, unknown> = { accountId: input.accountId, body: input.body, bodyIsHtml: input.bodyIsHtml };
  for (const key of ['aliasId', 'subject', 'quotedBody', 'quotedBodyHtml', 'inReplyTo', 'references',
    'replyToMessageId', 'replyParentMessageId', 'replyParentAccountId', 'sendKind', 'editedSignature', 'priority']) {
    if (input[key] === undefined || input[key] === null) continue;
    if (typeof input[key] !== 'string') invalid(`${key} must be a string`);
    out[key] = input[key];
  }
  if (typeof out.aliasId === 'string' && !UUID.test(out.aliasId)) invalid('Invalid sender alias');
  if (input.editedSignatureIsHtml !== undefined) {
    if (typeof input.editedSignatureIsHtml !== 'boolean') invalid('Signature format must be a boolean');
    out.editedSignatureIsHtml = input.editedSignatureIsHtml;
  }
  for (const key of ['to', 'cc', 'bcc']) {
    const values = input[key] ?? [];
    if (!Array.isArray(values) || values.length > 1000 || !values.every(v => typeof v === 'string')) invalid(`${key} must be a recipient list`);
    out[key] = values;
  }
  if (input.attachments !== undefined) {
    if (!Array.isArray(input.attachments) || input.attachments.length > 100) invalid('Invalid attachment list');
    out.attachments = input.attachments.map(value => {
      const a = record(value);
      if (typeof a.filename !== 'string' || !a.filename.trim() || typeof a.content !== 'string') invalid('Invalid attachment');
      if (a.contentType !== undefined && typeof a.contentType !== 'string') invalid('Invalid attachment type');
      return { filename: a.filename, content: a.content, ...(a.contentType ? { contentType: a.contentType } : {}) };
    });
  }
  if (input.forwardedAttachments !== undefined) {
    if (!Array.isArray(input.forwardedAttachments) || input.forwardedAttachments.length > 100) invalid('Invalid forwarded attachments');
    out.forwardedAttachments = input.forwardedAttachments.map(value => {
      const a = record(value);
      if (typeof a.messageId !== 'string' || !UUID.test(a.messageId) || typeof a.part !== 'string' || !a.part.trim()) invalid('Invalid forwarded attachment');
      return { messageId: a.messageId, part: a.part };
    });
  }
  // Every field was checked above; shared delivery validation checks recipients/limits.
  return out as SendRequestBody;
}
/** Require a positive safe revision for optimistic queue mutations. */
function requireRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid('A current message revision is required');
  return value;
}
/** Project private queue storage to owner-visible metadata only. */
function summary(row: ScheduledSummary): ScheduledSummary {
  const { id, accountId, subject, mode, state, scheduledAt, timeZone, revision, errorCode,
    senderEmail, to, cc, recipientCount } = row;
  return { id, accountId, subject, mode, state, scheduledAt, timeZone, revision, errorCode,
    senderEmail, to, cc, recipientCount };
}
/** Validate and freeze a message without acquiring a delivery intent. */
async function prepare(userId: string, message: SendRequestBody, execute: SendExecutor): Promise<PreparedSend> {
  const result = await execute(userId, message, null, { prepareOnly: true });
  if (result.status !== 200 || !result.prepared) {
    throw new ScheduledMailError(result.status >= 400 ? result.status : 500,
      typeof result.body.code === 'string' ? result.body.code : 'SCHEDULE_PREPARATION_FAILED',
      typeof result.body.error === 'string' ? result.body.error : 'Message could not be prepared');
  }
  return result.prepared;
}
/** Return an enqueue receipt only when its immutable request fingerprint matches. */
function replay(row: ScheduledRow, fingerprint: string): ScheduledSummary {
  if (row.request_fingerprint !== fingerprint) throw new ScheduledMailError(409, 'SCHEDULE_KEY_MISMATCH', 'This request key belongs to a different message');
  return summary(row);
}
/** Persist once only, even when the first enqueue acknowledgement is lost. */
export async function enqueueScheduledMail(userId: string, inputValue: unknown, key: string, execute: SendExecutor): Promise<ScheduledSummary> {
  if (!key || key.length > 128) invalid('A stable idempotency key is required');
  const input = record(inputValue);
  const mode = input.mode;
  if (mode !== 'undo' && mode !== 'schedule') invalid('Choose undo or schedule mode');
  const timeZone = validateTimeZone(input.timeZone);
  const message = validateScheduledPayload(input.message);
  const fingerprint = createHash('sha256').update(JSON.stringify({ message, mode, timeZone,
    scheduledAt: mode === 'schedule' ? input.scheduledAt : null })).digest('hex');
  // Replay before date/source validation: the original source can be gone and its
  // requested time can have passed while a client was waiting for its receipt.
  const existing = await query<ScheduledRow>(`SELECT ${DETAIL} FROM scheduled_mail WHERE user_id=$1 AND idempotency_key=$2`, [userId, key]);
  if (existing.rows[0]) return replay(existing.rows[0], fingerprint);
  if (mode === 'schedule') validateScheduledAt(input.scheduledAt);
  const pref = await query<{ preferences: { undoSendSeconds?: unknown } | null }>('SELECT preferences FROM users WHERE id=$1', [userId]);
  const delay = pref.rows[0]?.preferences?.undoSendSeconds ?? 0;
  if (mode === 'undo' && (!validUndoSendSeconds(delay) || delay === 0)) invalid('Undo Send is disabled');
  const prepared = await prepare(userId, message, execute);
  return withTransaction(async client => {
    // Serialize only small queue writes, never MIME preparation/provider reads.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('scheduled-mail'), hashtext($1))", [userId]);
    const raced = await client.query<ScheduledRow>(`SELECT ${DETAIL} FROM scheduled_mail WHERE user_id=$1 AND idempotency_key=$2`, [userId, key]);
    if (raced.rows[0]) return replay(raced.rows[0], fingerprint);
    const count = await client.query<{ count: string }>("SELECT count(*) FROM scheduled_mail WHERE user_id=$1 AND state NOT IN ('sent','cancelled','dismissed')", [userId]);
    if (Number(count.rows[0].count) >= MAX_ACTIVE) throw new ScheduledMailError(409, 'SCHEDULE_QUEUE_FULL', 'At most 100 active scheduled messages are allowed');
    // Undo time starts AFTER preparation, not before slow forwarded-attachment reads.
    const scheduledAt = mode === 'undo' ? new Date(Date.now() + Number(delay) * 1000) : validateScheduledAt(input.scheduledAt);
    if (mode === 'schedule') await requireFutureWrite(client, scheduledAt);
    const inserted = await client.query<ScheduledSummary>(`INSERT INTO scheduled_mail
      (id,user_id,account_id,idempotency_key,request_fingerprint,subject,mode,scheduled_at,time_zone,payload)
      SELECT $1,$2,a.id,$4,$5,$6,$7,$8,$9,$10::jsonb FROM email_accounts a WHERE a.id=$3 AND a.user_id=$2
      RETURNING ${SUMMARY}`, [randomUUID(), userId, message.accountId, key, fingerprint, prepared.payload.subject ?? '', mode, scheduledAt, timeZone, JSON.stringify(prepared)]);
    if (!inserted.rows[0]) throw new ScheduledMailError(404, 'SCHEDULE_ACCOUNT_MISSING', 'Sending account is no longer available');
    if (mode === 'schedule') await requireFutureWrite(client, scheduledAt);
    return inserted.rows[0];
  });
}
/** Split every unique mailbox into an independently dispatched queue item. */
export function mailMergeRecipients(message: SendRequestBody): string[] {
  const unique = new Map<string, string>();
  for (const field of ['to', 'cc', 'bcc'] as const) {
    for (const value of message[field] ?? []) {
      const mailbox = parseMailbox(value);
      if (!ADDRESS.test(mailbox.email) || /[\r\n\0]/.test(value) || (value.includes('<') && !/^[^<>]*<[^<>]+>\s*$/.test(value))) {
        invalid(`Invalid ${field} recipient`);
      }
      const address = mailbox.email.toLowerCase();
      if (!unique.has(address)) unique.set(address, value.trim());
    }
  }
  if (!unique.size) invalid('At least one recipient is required');
  if (unique.size > MAX_ACTIVE) invalid('Mail merge supports at most 100 unique recipients');
  return [...unique.values()];
}

/** Read batch children only for the same owner as the receipt, including after account deletion. */
async function mergeReceipt(client: DbClient, userId: string, row: MergeBatchRow): Promise<MergeReceipt> {
  const items = (await client.query<ScheduledSummary>(`SELECT ${SUMMARY} FROM scheduled_mail
    WHERE id=ANY($1::uuid[]) AND user_id=$2 ORDER BY array_position($1::uuid[], id)`, [row.item_ids, userId])).rows;
  return { id: row.id, count: row.item_ids.length, scheduledAt: row.scheduled_at, items };
}

/** Prepare every message before starting Undo Send, then insert the whole batch atomically. */
export async function enqueueMailMerge(userId: string, inputValue: unknown, key: string, execute: SendExecutor): Promise<MergeReceipt> {
  if (!key || key.length > 128) invalid('A stable idempotency key is required');
  const input = record(inputValue);
  const message = validateScheduledPayload(input.message);
  const recipients = mailMergeRecipients(message);
  const fingerprint = createHash('sha256').update(JSON.stringify({ message })).digest('hex');
  const existing = (await query<MergeBatchRow>('SELECT * FROM mail_merge_batches WHERE user_id=$1 AND idempotency_key=$2', [userId, key])).rows[0];
  if (existing) {
    if (existing.request_fingerprint !== fingerprint) throw new ScheduledMailError(409, 'MAIL_MERGE_KEY_MISMATCH', 'This request key belongs to a different mail merge');
    return mergeReceipt({ query }, userId, existing);
  }
  // Materialize forwarded bytes and the signature once. Every subsequent call still
  // passes one recipient through the real provider validation with the frozen input.
  const first = await prepare(userId, { ...message, to: [recipients[0]], cc: [], bcc: [] }, execute);
  const frozen = { ...first.payload, to: [], cc: [], bcc: [], forwardedAttachments: [] };
  for (const recipient of recipients.slice(1)) {
    const validated = await execute(userId, { ...frozen, to: [recipient] }, null,
      { prepareOnly: true, expectedSenderEmail: first.senderEmail });
    if (validated.status !== 200 || !validated.prepared) {
      throw new ScheduledMailError(validated.status >= 400 ? validated.status : 500,
        typeof validated.body.code === 'string' ? validated.body.code : 'SCHEDULE_PREPARATION_FAILED',
        typeof validated.body.error === 'string' ? validated.body.error : 'Message could not be prepared');
    }
    if (validated.prepared.senderEmail.toLowerCase() !== first.senderEmail.toLowerCase()) {
      throw new ScheduledMailError(409, 'SCHEDULE_SENDER_CHANGED', 'The selected sender changed during mail merge preparation');
    }
  }
  return withTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('scheduled-mail'), hashtext($1))", [userId]);
    const raced = (await client.query<MergeBatchRow>('SELECT * FROM mail_merge_batches WHERE user_id=$1 AND idempotency_key=$2', [userId, key])).rows[0];
    if (raced) {
      if (raced.request_fingerprint !== fingerprint) throw new ScheduledMailError(409, 'MAIL_MERGE_KEY_MISMATCH', 'This request key belongs to a different mail merge');
      return mergeReceipt(client, userId, raced);
    }
    const count = await client.query<{ count: string }>("SELECT count(*) FROM scheduled_mail WHERE user_id=$1 AND state NOT IN ('sent','cancelled','dismissed')", [userId]);
    if (Number(count.rows[0].count) + recipients.length > MAX_ACTIVE) {
      throw new ScheduledMailError(409, 'SCHEDULE_QUEUE_FULL', 'At most 100 active scheduled messages are allowed');
    }
    const pref = await client.query<{ preferences: { undoSendSeconds?: unknown } | null }>('SELECT preferences FROM users WHERE id=$1', [userId]);
    const delay = pref.rows[0]?.preferences?.undoSendSeconds ?? 0;
    if (!validUndoSendSeconds(delay)) invalid('Invalid Undo Send preference');
    let scheduledAt = new Date(Date.now() + delay * 1000);
    const batchId = randomUUID();
    const itemIds = recipients.map(() => randomUUID());
    const insertIds: string[] = [];
    const insertKeys: string[] = [];
    const insertFingerprints: string[] = [];
    const insertSubjects: string[] = [];
    const insertPayloads: string[] = [];

    for (const [index, recipient] of recipients.entries()) {
      const item: PreparedSend = { senderEmail: first.senderEmail,
        payload: { ...frozen, to: [recipient] } };
      insertIds.push(itemIds[index]);
      insertKeys.push(`merge:${batchId}:${index}`);
      insertFingerprints.push(createHash('sha256').update(JSON.stringify({ fingerprint, recipient })).digest('hex'));
      insertSubjects.push(item.payload.subject ?? '');
      insertPayloads.push(JSON.stringify(item));
    }

    if (insertIds.length > 0) {
      const inserted = await client.query(`INSERT INTO scheduled_mail
        (id,user_id,account_id,idempotency_key,request_fingerprint,subject,mode,scheduled_at,time_zone,payload)
        SELECT u.id,$1,a.id,u.key,u.fingerprint,u.subject,'undo',$3,'UTC',u.payload::jsonb
        FROM unnest($4::uuid[], $5::text[], $6::text[], $7::text[], $8::jsonb[]) AS u(id, key, fingerprint, subject, payload)
        CROSS JOIN email_accounts a
        WHERE a.id=$2 AND a.user_id=$1
        RETURNING id`, [
          userId, message.accountId, scheduledAt,
          insertIds, insertKeys, insertFingerprints, insertSubjects, insertPayloads
        ]);
      if (!inserted.rows[0]) throw new ScheduledMailError(404, 'SCHEDULE_ACCOUNT_MISSING', 'Sending account is no longer available');
    }
    // Large batches can spend time writing attachment snapshots. No worker can
    // see these uncommitted rows; begin the full Undo window after those writes.
    scheduledAt = new Date(Date.now() + delay * 1000);
    await client.query('UPDATE scheduled_mail SET scheduled_at=$2 WHERE id=ANY($1::uuid[]) AND user_id=$3',
      [itemIds, scheduledAt, userId]);
    await client.query(`INSERT INTO mail_merge_batches(id,user_id,idempotency_key,request_fingerprint,item_ids,scheduled_at)
      VALUES($1,$2,$3,$4,$5::uuid[],$6)`, [batchId, userId, key, fingerprint, itemIds, scheduledAt]);
    return mergeReceipt(client, userId, { id: batchId, request_fingerprint: fingerprint, item_ids: itemIds, scheduled_at: scheduledAt });
  });
}

const VISIBLE = `(state NOT IN ('sent','cancelled','dismissed')
  OR (state='sent' AND sent_seen_at IS NULL)
  OR (state='dismissed' AND updated_at > clock_timestamp() - interval '7 days'))`;
const ACTIVE_ORDER = "CASE WHEN state IN ('sent','cancelled','dismissed') THEN 0 ELSE 1 END";
const PAGE_SIZE = 200;
interface QueueCursor { active: number; at: string; id: string }
/** Validate an opaque keyset cursor before passing its exact microseconds to PostgreSQL. */
function decodeCursor(value: unknown): QueueCursor | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) invalid('Invalid queue cursor');
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as QueueCursor;
    if (!cursor || (cursor.active !== 0 && cursor.active !== 1) || typeof cursor.id !== 'string' || !UUID.test(cursor.id)
      || typeof cursor.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.at)) invalid('Invalid queue cursor');
    const millis = cursor.at.slice(0, 23) + 'Z';
    if (new Date(millis).toISOString() !== millis) invalid('Invalid queue cursor');
    return cursor;
  } catch { return invalid('Invalid queue cursor'); }
}
/** Page all unseen results, including old history. Reads never acknowledge visibility. */
export async function pageScheduledMail(userId: string, cursorValue?: unknown): Promise<{ items: ScheduledSummary[]; nextCursor: string | null }> {
  const cursor = decodeCursor(cursorValue);
  const rows = (await query<ScheduledSummary & { cursorTime: string; cursorActive: number }>(`SELECT ${SUMMARY},
    to_char(scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime",
    ${ACTIVE_ORDER} AS "cursorActive" FROM scheduled_mail WHERE user_id=$1 AND ${VISIBLE}
    AND ($2::int IS NULL OR (${ACTIVE_ORDER},scheduled_at,id) < ($2::int,$3::timestamptz,$4::uuid))
    ORDER BY ${ACTIVE_ORDER} DESC, scheduled_at DESC, id DESC LIMIT ${PAGE_SIZE + 1}`,
  [userId, cursor?.active ?? null, cursor?.at ?? null, cursor?.id ?? null])).rows;
  const page = rows.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  const nextCursor = rows.length > PAGE_SIZE && last ? Buffer.from(JSON.stringify({
    active: last.cursorActive, at: last.cursorTime, id: last.id,
  })).toString('base64url') : null;
  return { items: page.map(summary), nextCursor };
}
/** The global Undo/polling feed always includes every active item (the active cap is 100). */
export async function getScheduledSummary(userId: string, id: string): Promise<ScheduledSummary> {
  requireScheduledId(id);
  const row = (await query<ScheduledSummary>(`SELECT ${SUMMARY} FROM scheduled_mail
    WHERE id=$1 AND user_id=$2 AND state NOT IN ('cancelled','dismissed')`, [id,userId])).rows[0];
  if (!row) throw new ScheduledMailError(404,'SCHEDULE_MISSING','Scheduled message is not available');
  return summary(row);
}

export async function listScheduledMail(userId: string): Promise<ScheduledSummary[]> {
  return (await pageScheduledMail(userId)).items;
}
/** A separate idempotent receipt: never bump delivery revisions or touch the send ledger. */
export async function acknowledgeSentMail(userId: string, id: string): Promise<{ id: string }> {
  requireScheduledId(id);
  const result = await query<{ id: string }>(`UPDATE scheduled_mail
    SET sent_seen_at=COALESCE(sent_seen_at,clock_timestamp())
    WHERE id=$1 AND user_id=$2 AND state='sent' RETURNING id`, [id, userId]);
  if (!result.rows[0]) throw new ScheduledMailError(404, 'SCHEDULE_SENT_MISSING', 'Sent result is not available');
  return result.rows[0];
}
/** Pausing wins atomically against worker claiming, and is idempotent at this revision. */
export async function editScheduledMail(userId: string, id: string, revision: unknown): Promise<ScheduledRow> {
  requireScheduledId(id);
  const result = await query<ScheduledRow>(`UPDATE scheduled_mail SET state='editing', updated_at=clock_timestamp(), last_error_code=NULL
    WHERE id=$1 AND user_id=$2 AND revision=$3 AND state IN ('pending','editing','failed','partial') RETURNING ${DETAIL}`,
  [id, userId, requireRevision(revision)]);
  if (!result.rows[0]) throw new ScheduledMailError(409, 'SCHEDULE_CHANGED', 'The message changed or submission has already started. Refresh the queue.');
  return result.rows[0];
}
/** Save a paused editor or queue its replacement, with versioned lost-ack replay. */
export async function updateScheduledMail(userId: string, id: string, inputValue: unknown, execute: SendExecutor): Promise<ScheduledSummary> {
  requireScheduledId(id);
  const input = record(inputValue);
  const revision = requireRevision(input.revision);
  for (const flag of ['keepEditing', 'sendNow']) {
    if (input[flag] !== undefined && typeof input[flag] !== 'boolean') invalid(`${flag} must be a boolean`);
  }
  const keepEditing = input.keepEditing === true;
  const sendNow = input.sendNow === true;
  if (keepEditing && sendNow) invalid('Saving and sending are separate actions');
  const timeZone = keepEditing ? null : validateTimeZone(input.timeZone);
  const message = validateScheduledPayload(input.message);
  const fingerprint = createHash('sha256').update(JSON.stringify({ revision, message, keepEditing, sendNow,
    timeZone, scheduledAt: keepEditing || sendNow ? null : input.scheduledAt })).digest('hex');
  const owned = await query<ScheduledRow>(`SELECT ${DETAIL} FROM scheduled_mail WHERE id=$1 AND user_id=$2`, [id, userId]);
  const row = owned.rows[0];
  // A repeated save/send acknowledgement must never enqueue another copy, even
  // when the requested time has passed or this revision has already been sent.
  if (row?.revision === revision + 1 && row.edit_fingerprint === fingerprint) return summary(row);
  if (!row || row.revision !== revision || row.state !== 'editing') {
    throw new ScheduledMailError(409, 'SCHEDULE_CHANGED', 'Pause the current message before editing it');
  }
  if (!keepEditing && !sendNow) validateScheduledAt(input.scheduledAt);
  const prepared = await prepare(userId, message, execute);
  let delay = 0;
  if (sendNow) {
    const pref = await query<{ preferences: { undoSendSeconds?: unknown } | null }>('SELECT preferences FROM users WHERE id=$1', [userId]);
    const value = pref.rows[0]?.preferences?.undoSendSeconds ?? 0;
    if (!validUndoSendSeconds(value)) invalid('Invalid Undo Send preference');
    delay = value;
  }
  return withTransaction(async client => {
    // Lock before checking wall time; identical retries replay before expiry validation.
    const current = (await client.query<ScheduledRow>(`SELECT ${DETAIL} FROM scheduled_mail
      WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, userId])).rows[0];
    if (current?.revision === revision + 1 && current.edit_fingerprint === fingerprint) return summary(current);
    if (!current || current.revision !== revision || current.state !== 'editing') {
      throw new ScheduledMailError(409, 'SCHEDULE_CHANGED', 'Pause the current message before editing it');
    }
    const scheduledAt = keepEditing ? row.scheduledAt : sendNow
      ? new Date(Date.now() + delay * 1000) : validateScheduledAt(input.scheduledAt);
    if (!keepEditing && !sendNow) await requireFutureWrite(client, scheduledAt);
    const state = keepEditing ? 'editing' : 'pending';
    const mode = keepEditing ? row.mode : sendNow ? 'undo' : 'schedule';
    const result = await client.query<ScheduledSummary>(`UPDATE scheduled_mail q SET account_id=$4, payload=$5::jsonb, subject=$6,
      scheduled_at=$7, time_zone=$8, state=$9, mode=$10, revision=revision+1, result=NULL,
      dispatch_started_at=NULL, last_error_code=NULL, edit_fingerprint=$11, updated_at=clock_timestamp()
      WHERE q.id=$1 AND q.user_id=$2 AND q.revision=$3 AND q.state='editing'
        AND EXISTS (SELECT 1 FROM email_accounts a WHERE a.id=$4 AND a.user_id=$2)
      RETURNING ${SUMMARY}`, [id, userId, revision, message.accountId, JSON.stringify(prepared), prepared.payload.subject ?? '',
      scheduledAt, timeZone ?? row.timeZone, state, mode, fingerprint]);
    if (result.rows[0]) {
      if (!keepEditing && !sendNow) await requireFutureWrite(client, scheduledAt);
      return result.rows[0];
    }
    throw new ScheduledMailError(409, 'SCHEDULE_CHANGED', 'The message changed in another client. Your queued version was not replaced.');
  });
}
/** Reschedule without fetching/rebuilding attachments; never rearms an uncertain send. */
export async function rescheduleMail(userId: string, id: string, inputValue: unknown): Promise<ScheduledSummary> {
  requireScheduledId(id);
  const input = record(inputValue);
  const revision = requireRevision(input.revision);
  const scheduledAt = validateScheduledAt(input.scheduledAt);
  const timeZone = validateTimeZone(input.timeZone);
  return withTransaction(async client => {
    const owned = await client.query(`SELECT id FROM scheduled_mail
      WHERE id=$1 AND user_id=$2 AND revision=$3 AND state IN ('pending','editing') FOR UPDATE`, [id, userId, revision]);
    if (!owned.rows[0]) throw new ScheduledMailError(409, 'SCHEDULE_CHANGED', 'The message changed or cannot be rescheduled');
    await requireFutureWrite(client, scheduledAt);
    const result = await client.query<ScheduledSummary>(`UPDATE scheduled_mail SET scheduled_at=$4, time_zone=$5, mode='schedule',
      state='pending', revision=revision+1, updated_at=clock_timestamp(), last_error_code=NULL
      WHERE id=$1 AND user_id=$2 AND revision=$3 AND state IN ('pending','editing') RETURNING ${SUMMARY}`,
    [id, userId, revision, scheduledAt, timeZone]);
    if (!result.rows[0]) throw new ScheduledMailError(409, 'SCHEDULE_CHANGED', 'The message changed or cannot be rescheduled');
    await requireFutureWrite(client, scheduledAt);
    return result.rows[0];
  });
}
/** Cancellation is permitted only while no provider submission can be in progress. */
export async function cancelScheduledMail(userId: string, id: string, revision: unknown): Promise<ScheduledSummary> {
  requireScheduledId(id);
  const expected = requireRevision(revision);
  const result = await query<ScheduledSummary>(`UPDATE scheduled_mail SET state='cancelled', payload='{}'::jsonb,
    revision=revision+1, updated_at=clock_timestamp(), last_error_code=NULL
    WHERE id=$1 AND user_id=$2 AND revision=$3 AND state IN ('pending','editing','failed','partial') RETURNING ${SUMMARY}`,
  [id, userId, expected]);
  if (result.rows[0]) return result.rows[0];
  const replayed = await query<ScheduledSummary>(`SELECT ${SUMMARY} FROM scheduled_mail
    WHERE id=$1 AND user_id=$2 AND revision=$3 AND state='cancelled'`, [id, userId, expected + 1]);
  if (replayed.rows[0]) return replayed.rows[0];
  throw new ScheduledMailError(409, 'SCHEDULE_CHANGED', 'The message changed or submission has already started');
}

/** Acknowledge an uncertain outcome without recalling or resubmitting anything.
 * Purge payload/provider-result recipients, but retain the idempotency tombstone.
 * The previous revision can replay its acknowledgement after a lost response.
 */
export async function dismissScheduledMail(userId: string, id: string, revision: unknown): Promise<ScheduledSummary> {
  requireScheduledId(id);
  const expected = requireRevision(revision);
  const result = await query<ScheduledSummary>(`UPDATE scheduled_mail SET state='dismissed', payload='{}'::jsonb,
    result=NULL, revision=revision+1, updated_at=clock_timestamp(), last_error_code=NULL
    WHERE id=$1 AND user_id=$2 AND revision=$3 AND state='uncertain' RETURNING ${SUMMARY}`,
  [id, userId, expected]);
  if (result.rows[0]) return result.rows[0];
  const replayed = await query<ScheduledSummary>(`SELECT ${SUMMARY} FROM scheduled_mail
    WHERE id=$1 AND user_id=$2 AND revision=$3 AND state='dismissed'`, [id, userId, expected + 1]);
  if (replayed.rows[0]) return replayed.rows[0];
  throw new ScheduledMailError(409, 'SCHEDULE_CHANGED', 'Only a current uncertain outcome can be dismissed. Refresh the queue.');
}

/** Release only when the send service proves its final gate refused submission.
 * Never use this for transport errors. A new revision avoids abandoned reservations.
 */
export async function releaseScheduledClaim(row: ScheduledRow): Promise<void> {
  await query(`UPDATE scheduled_mail SET state='pending', revision=revision+1, lease_token=NULL, lease_until=NULL,
    dispatch_started_at=NULL, last_error_code=NULL, updated_at=clock_timestamp()
    WHERE id=$1 AND lease_token=$2 AND state IN ('preparing','sending')`, [row.id, row.lease_token]);
}

/** Claim a single due row without holding a transaction open during network I/O. */
export async function claimScheduledMail(): Promise<ScheduledRow | null> {
  const token = randomUUID();
  const result = await query<ScheduledRow>(`UPDATE scheduled_mail SET state='preparing', lease_token=$1,
    lease_until=clock_timestamp()+interval '2 minutes', updated_at=clock_timestamp()
    WHERE id=(SELECT id FROM scheduled_mail WHERE state='pending' AND scheduled_at<=clock_timestamp()
      ORDER BY scheduled_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING ${DETAIL}`, [token]);
  return result.rows[0] ?? null;
}
/** Renew only a live owned lease; never revive an expired token. */
export async function renewScheduledClaim(row: ScheduledRow): Promise<boolean> {
  return !!(await query(`UPDATE scheduled_mail SET lease_until=clock_timestamp()+interval '2 minutes'
    WHERE id=$1 AND lease_token=$2 AND state IN ('preparing','sending') AND lease_until>clock_timestamp() RETURNING id`,
  [row.id, row.lease_token])).rows.length;
}
/** This is the last gate immediately before the existing durable delivery gate. */
export async function beginScheduledDispatch(row: ScheduledRow): Promise<boolean> {
  return !!(await query(`UPDATE scheduled_mail SET state='sending', dispatch_started_at=clock_timestamp(), updated_at=clock_timestamp()
    WHERE id=$1 AND lease_token=$2 AND state='preparing' AND lease_until>clock_timestamp() RETURNING id`,
  [row.id, row.lease_token])).rows.length;
}
/** Canonicalize addresses for comparing provider recipient outcomes. */
function recipientAddress(value: string): string {
  return (value.match(/<([^<>]+)>/)?.[1] ?? value).trim().toLowerCase();
}
/** Retain rejected addresses in their original To/CC/BCC roles. */
function rejectedPayload(payload: PreparedSend, rejected: string[]): PreparedSend {
  const addresses = new Set(rejected.map(recipientAddress));
  return { ...payload, payload: { ...payload.payload,
    to: (payload.payload.to ?? []).filter(value => addresses.has(recipientAddress(value))),
    cc: (payload.payload.cc ?? []).filter(value => addresses.has(recipientAddress(value))),
    bcc: (payload.payload.bcc ?? []).filter(value => addresses.has(recipientAddress(value))),
  } };
}
/** Classify live and durably recorded outcomes identically, without ever submitting. */
function completion(prepared: PreparedSend, response: SendExecutionResult) {
  const rejected = Array.isArray(response.body.rejected) ? response.body.rejected.filter((v): v is string => typeof v === 'string') : [];
  const partial = response.body.partialDelivery === true || rejected.length > 0;
  const accepted = response.status >= 200 && response.status < 300 && response.body.ok === true;
  let state: ScheduledState = accepted ? (partial ? 'partial' : 'sent')
    : response.body.code === 'SEND_OUTCOME_UNKNOWN' ? 'uncertain' : 'failed';
  const original = new Set([...(prepared.payload.to ?? []), ...(prepared.payload.cc ?? []), ...(prepared.payload.bcc ?? [])].map(recipientAddress));
  const acceptedAddresses = new Set(Array.isArray(response.body.accepted)
    ? response.body.accepted.filter((v): v is string => typeof v === 'string').map(recipientAddress) : []);
  const malformedRejected = response.body.rejected !== undefined && (!Array.isArray(response.body.rejected)
    || response.body.rejected.some(value => typeof value !== 'string'));
  // Incomplete/contradictory recipient evidence must not create a retry target.
  if (accepted && (malformedRejected || (partial && (!rejected.length
    || rejected.some(value => !original.has(recipientAddress(value)) || acceptedAddresses.has(recipientAddress(value))))))) state = 'uncertain';
  const payload = state === 'sent' ? {} : state === 'partial' ? rejectedPayload(prepared, rejected) : prepared;
  const code = state === 'uncertain' ? 'SEND_OUTCOME_UNKNOWN'
    : typeof response.body.code === 'string' ? response.body.code : state === 'failed' ? 'SCHEDULE_SEND_FAILED' : null;
  return { state, payload, code };
}
/** Retain only the visible delivery headers, never another full message or BCC list. */
function sentMetadata(prepared: PreparedSend, state: ScheduledState): Record<string, unknown> {
  if (state !== 'sent') return {};
  const message = prepared.payload;
  return { senderEmail: prepared.senderEmail, to: message.to ?? [], cc: message.cc ?? [],
    recipientCount: (message.to?.length ?? 0) + (message.cc?.length ?? 0) + (message.bcc?.length ?? 0) };
}
/** Preserve rejected-only recipients after partial delivery, never accepted ones. */
export async function completeScheduledMail(row: ScheduledRow, response: SendExecutionResult): Promise<void> {
  const { state, payload, code } = completion(row.payload, response);
  await query(`UPDATE scheduled_mail SET state=$3, payload=$4::jsonb, result=$5::jsonb, last_error_code=$6,
    sent_metadata=$7::jsonb, lease_token=NULL, lease_until=NULL, updated_at=clock_timestamp()
    WHERE id=$1 AND lease_token=$2 AND state IN ('preparing','sending')`,
  [row.id, row.lease_token, state, JSON.stringify(payload), JSON.stringify(response.body), code,
    JSON.stringify(sentMetadata(row.payload, state))]);
}
/** Recover expired preparation, but park any potentially submitted message. */
export async function recoverScheduledMail(db: DbClient = { query }): Promise<void> {
  await db.query(`UPDATE scheduled_mail SET state='pending', revision=revision+1, lease_token=NULL, lease_until=NULL, updated_at=clock_timestamp()
    WHERE state='preparing' AND lease_until<=clock_timestamp()`);
  await db.query(`UPDATE scheduled_mail SET state='uncertain', lease_token=NULL, lease_until=NULL,
    last_error_code='SEND_OUTCOME_UNKNOWN', updated_at=clock_timestamp()
    WHERE state='sending' AND lease_until<=clock_timestamp()`);
  // Observe durable completed receipts only. The same classifier restores a
  // rejected-only editor after a partial acceptance; no provider call is made.
  const receipts = await db.query<{ id: string; revision: number; payload: PreparedSend; result: Record<string, unknown> }>(`
    SELECT q.id, q.revision, q.payload, s.result FROM scheduled_mail q
    JOIN send_idempotency s ON s.user_id=q.user_id
      AND s.idempotency_key='scheduled:'||q.id::text||':'||q.revision::text
    WHERE q.state='uncertain' AND s.status='completed' AND s.result->>'ok'='true'
    ORDER BY q.updated_at,q.id LIMIT 100`);
  for (const row of receipts.rows) {
    const { state, payload, code } = completion(row.payload, { status: 200, body: row.result });
    if (state === 'uncertain') continue;
    await db.query(`UPDATE scheduled_mail SET state=$3, payload=$4::jsonb, result=$5::jsonb,
      last_error_code=$6, sent_metadata=$7::jsonb, updated_at=clock_timestamp() WHERE id=$1 AND revision=$2 AND state='uncertain'`,
    [row.id, row.revision, state, JSON.stringify(payload), JSON.stringify(row.result), code,
      JSON.stringify(sentMetadata(row.payload, state))]);
  }
}
