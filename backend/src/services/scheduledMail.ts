import { createHash, randomUUID } from 'node:crypto';
import { validUndoSendSeconds } from '../utils/undoSend.js';
import { query, withTransaction } from './db.js';
import type { DbClient } from './db.js';
import type { PreparedSend, SendExecutionOptions, SendExecutionResult, SendRequestBody } from './sendMail.js';

export type SendExecutor = (userId: string, payload: SendRequestBody, key: string | null,
  options?: SendExecutionOptions) => Promise<SendExecutionResult>;
export type ScheduledState = 'pending' | 'editing' | 'preparing' | 'sending' | 'sent' | 'partial' | 'failed' | 'uncertain' | 'cancelled';
export interface ScheduledSummary {
  id: string; accountId: string; subject: string; mode: 'undo' | 'schedule'; state: ScheduledState;
  scheduledAt: Date; timeZone: string; revision: number; errorCode: string | null;
}
export interface ScheduledRow extends ScheduledSummary {
  user_id: string; payload: PreparedSend; lease_token: string | null; request_fingerprint: string; edit_fingerprint: string | null;
}
const SUMMARY = `id, account_id AS "accountId", subject, mode, state, scheduled_at AS "scheduledAt",
  time_zone AS "timeZone", revision, last_error_code AS "errorCode"`;
const DETAIL = `${SUMMARY}, user_id, payload, lease_token, request_fingerprint, edit_fingerprint`;
const MAX_ACTIVE = 100;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Expected user errors are safe to expose; infrastructure errors use normal middleware. */
export class ScheduledMailError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
function invalid(message: string): never { throw new ScheduledMailError(400, 'SCHEDULE_INVALID', message); }
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
  if (date.getTime() <= now) invalid('Scheduled time must be in the future');
  return date;
}
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
function requireRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid('A current message revision is required');
  return value;
}
function summary(row: ScheduledSummary): ScheduledSummary {
  const { id, accountId, subject, mode, state, scheduledAt, timeZone, revision, errorCode } = row;
  return { id, accountId, subject, mode, state, scheduledAt, timeZone, revision, errorCode };
}
async function prepare(userId: string, message: SendRequestBody, execute: SendExecutor): Promise<PreparedSend> {
  const result = await execute(userId, message, null, { prepareOnly: true });
  if (result.status !== 200 || !result.prepared) {
    throw new ScheduledMailError(result.status >= 400 ? result.status : 500,
      typeof result.body.code === 'string' ? result.body.code : 'SCHEDULE_PREPARATION_FAILED',
      typeof result.body.error === 'string' ? result.body.error : 'Message could not be prepared');
  }
  return result.prepared;
}
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
    const count = await client.query<{ count: string }>("SELECT count(*) FROM scheduled_mail WHERE user_id=$1 AND state NOT IN ('sent','cancelled')", [userId]);
    if (Number(count.rows[0].count) >= MAX_ACTIVE) throw new ScheduledMailError(409, 'SCHEDULE_QUEUE_FULL', 'At most 100 active scheduled messages are allowed');
    // Undo time starts AFTER preparation, not before slow forwarded-attachment reads.
    const scheduledAt = mode === 'undo' ? new Date(Date.now() + Number(delay) * 1000) : validateScheduledAt(input.scheduledAt);
    const inserted = await client.query<ScheduledSummary>(`INSERT INTO scheduled_mail
      (id,user_id,account_id,idempotency_key,request_fingerprint,subject,mode,scheduled_at,time_zone,payload)
      SELECT $1,$2,a.id,$4,$5,$6,$7,$8,$9,$10::jsonb FROM email_accounts a WHERE a.id=$3 AND a.user_id=$2
      RETURNING ${SUMMARY}`, [randomUUID(), userId, message.accountId, key, fingerprint, prepared.payload.subject ?? '', mode, scheduledAt, timeZone, JSON.stringify(prepared)]);
    if (!inserted.rows[0]) throw new ScheduledMailError(404, 'SCHEDULE_ACCOUNT_MISSING', 'Sending account is no longer available');
    return inserted.rows[0];
  });
}
/** List metadata only; attachment bytes and BCC are never broadcast/listed. */
export async function listScheduledMail(userId: string): Promise<ScheduledSummary[]> {
  return (await query<ScheduledSummary>(`SELECT ${SUMMARY} FROM scheduled_mail WHERE user_id=$1
    AND (state NOT IN ('sent','cancelled') OR updated_at > clock_timestamp() - interval '7 days')
    ORDER BY (state NOT IN ('sent','cancelled')) DESC, scheduled_at DESC, id LIMIT 200`, [userId])).rows;
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
  const scheduledAt = keepEditing ? row.scheduledAt : sendNow
    ? new Date(Date.now() + delay * 1000) : validateScheduledAt(input.scheduledAt);
  const state = keepEditing ? 'editing' : 'pending';
  const mode = keepEditing ? row.mode : sendNow ? 'undo' : 'schedule';
  const result = await query<ScheduledSummary>(`UPDATE scheduled_mail q SET account_id=$4, payload=$5::jsonb, subject=$6,
    scheduled_at=$7, time_zone=$8, state=$9, mode=$10, revision=revision+1, result=NULL,
    dispatch_started_at=NULL, last_error_code=NULL, edit_fingerprint=$11, updated_at=clock_timestamp()
    WHERE q.id=$1 AND q.user_id=$2 AND q.revision=$3 AND q.state='editing'
      AND EXISTS (SELECT 1 FROM email_accounts a WHERE a.id=$4 AND a.user_id=$2)
    RETURNING ${SUMMARY}`, [id, userId, revision, message.accountId, JSON.stringify(prepared), prepared.payload.subject ?? '',
    scheduledAt, timeZone ?? row.timeZone, state, mode, fingerprint]);
  if (result.rows[0]) return result.rows[0];
  // Two identical concurrent retries can race after preparation. Only the first
  // writes; the second observes its exact new revision, never sends independently.
  const raced = (await query<ScheduledRow>(`SELECT ${DETAIL} FROM scheduled_mail WHERE id=$1 AND user_id=$2`, [id, userId])).rows[0];
  if (raced?.revision === revision + 1 && raced.edit_fingerprint === fingerprint) return summary(raced);
  throw new ScheduledMailError(409, 'SCHEDULE_CHANGED', 'The message changed in another client. Your queued version was not replaced.');
}
/** Reschedule without fetching/rebuilding attachments; never rearms an uncertain send. */
export async function rescheduleMail(userId: string, id: string, inputValue: unknown): Promise<ScheduledSummary> {
  requireScheduledId(id);
  const input = record(inputValue);
  const result = await query<ScheduledSummary>(`UPDATE scheduled_mail SET scheduled_at=$4, time_zone=$5, mode='schedule',
    state='pending', revision=revision+1, updated_at=clock_timestamp(), last_error_code=NULL
    WHERE id=$1 AND user_id=$2 AND revision=$3 AND state IN ('pending','editing') RETURNING ${SUMMARY}`,
  [id, userId, requireRevision(input.revision), validateScheduledAt(input.scheduledAt), validateTimeZone(input.timeZone)]);
  if (!result.rows[0]) throw new ScheduledMailError(409, 'SCHEDULE_CHANGED', 'The message changed or cannot be rescheduled');
  return result.rows[0];
}
/** Cancellation is permitted only while no provider submission can be in progress. */
export async function cancelScheduledMail(userId: string, id: string, revision: unknown): Promise<ScheduledSummary> {
  requireScheduledId(id);
  const result = await query<ScheduledSummary>(`UPDATE scheduled_mail SET state='cancelled', payload='{}'::jsonb,
    revision=revision+1, updated_at=clock_timestamp(), last_error_code=NULL
    WHERE id=$1 AND user_id=$2 AND revision=$3 AND state IN ('pending','editing','failed','partial') RETURNING ${SUMMARY}`,
  [id, userId, requireRevision(revision)]);
  if (!result.rows[0]) throw new ScheduledMailError(409, 'SCHEDULE_CHANGED', 'The message changed or submission has already started');
  return result.rows[0];
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
function recipientAddress(value: string): string {
  return (value.match(/<([^<>]+)>/)?.[1] ?? value).trim().toLowerCase();
}
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
/** Preserve rejected-only recipients after partial delivery, never accepted ones. */
export async function completeScheduledMail(row: ScheduledRow, response: SendExecutionResult): Promise<void> {
  const { state, payload, code } = completion(row.payload, response);
  await query(`UPDATE scheduled_mail SET state=$3, payload=$4::jsonb, result=$5::jsonb, last_error_code=$6,
    lease_token=NULL, lease_until=NULL, updated_at=clock_timestamp()
    WHERE id=$1 AND lease_token=$2 AND state IN ('preparing','sending')`,
  [row.id, row.lease_token, state, JSON.stringify(payload), JSON.stringify(response.body), code]);
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
      last_error_code=$6, updated_at=clock_timestamp() WHERE id=$1 AND revision=$2 AND state='uncertain'`,
    [row.id, row.revision, state, JSON.stringify(payload), JSON.stringify(row.result), code]);
  }
}
