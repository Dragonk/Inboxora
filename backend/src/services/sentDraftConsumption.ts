import { query } from './db.js';
import type { EmailAccountRow } from './imapManager.js';
import { imapManager } from '../index.js';
import { toAppError } from '../utils/errors.js';
import { resolveMailTransportForSync } from './mailTransportTarget.js';
import {
  deleteGmailUserDraft,
  findGmailDraftIdForMessage,
  gmailDraftMessageIdForLocalRow,
} from './providers/google/gmailMailDrafts.js';
import { deleteGraphUserDraft, graphDraftIdForLocalRow } from './providers/microsoft/graphMailDrafts.js';

/**
 * The draft a delivered send supersedes.
 *
 * A sent message must leave no draft behind: the provider object is removed and the local
 * rows deleted once delivery is confirmed. Until this existed, removal was the client's
 * fire-and-forget request — a path MCP sends never had at all — so every draft saved while
 * composing survived the message it became, and a late draft save could resurrect one after
 * the client's delete had already run.
 */

/** One superseded draft, as the composer's save or an MCP compose flow identified it. */
export interface SentDraftIdentity {
  accountId: string;
  uid: number | string;
  folder: string;
  uidValidity?: number | string | null;
}

function positiveInteger(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value
    : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

/** The composer's `existingDraft` body field, normalised; null when unusable. */
function sentDraftIdentity(value: unknown): SentDraftIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.accountId !== 'string' || !candidate.accountId) return null;
  const uid = typeof candidate.uid === 'number' || (typeof candidate.uid === 'string' && /^[1-9]\d*$/.test(candidate.uid)) ? candidate.uid : null;
  if (uid === null) return null;
  if (typeof candidate.folder !== 'string' || !candidate.folder || candidate.folder.length > 1024 || /[\0\r\n]/.test(candidate.folder)) return null;
  if (candidate.uidValidity === undefined || candidate.uidValidity === null) return { accountId: candidate.accountId, uid, folder: candidate.folder, uidValidity: null };
  const uidValidity = positiveInteger(candidate.uidValidity);
  if (uidValidity === null) return null;
  return { accountId: candidate.accountId, uid, folder: candidate.folder, uidValidity };
}

const identityKey = (identity: SentDraftIdentity) => `${identity.accountId}\u0000${identity.uid}\u0000${identity.folder}`;

/**
 * Remove the provider draft and local rows of one superseded draft.
 *
 * Returns true when the draft is gone (or no local draft existed). False means the removal
 * could not be confirmed, so the local row is deliberately retained: an unresolved Gmail
 * lookup or an unconfirmed IMAP identity must not drop the row, because the next sync would
 * re-import the surviving provider draft.
 */
export async function consumeSentDraft(userId: string, identity: SentDraftIdentity): Promise<boolean> {
  const accountRows = await query<EmailAccountRow>(
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
    [identity.accountId, userId],
  );
  const account = accountRows.rows[0];
  if (!account) return false;

  if (account.mail_transport === 'gmail_api') {
    const target = await resolveMailTransportForSync(userId, account.id);
    if (target.kind !== 'gmail') return false;
    const api = { userId, connectionId: target.connectionId, config: target.config };
    const messageId = await gmailDraftMessageIdForLocalRow(account.id, identity.uid, identity.folder);
    if (!messageId) {
      // No provider identity on the row: the local row is the only remnant of this draft.
      await query(
        'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3',
        [account.id, String(identity.uid), identity.folder],
      );
      return true;
    }
    const draftId = await findGmailDraftIdForMessage(api, messageId, { attempts: 3, delayMs: 400 });
    if (!draftId) return false; // ambiguous; the sync reconciles the row either way
    await deleteGmailUserDraft(api, draftId);
    await query(
      'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3 AND provider_message_id = $4',
      [account.id, String(identity.uid), identity.folder, messageId],
    );
    return true;
  }

  if (account.mail_transport === 'microsoft_graph') {
    const target = await resolveMailTransportForSync(userId, account.id);
    if (target.kind !== 'graph') return false;
    const api = { userId, connectionId: target.connectionId, config: target.config };
    const providerDraftId = await graphDraftIdForLocalRow(account.id, identity.uid, identity.folder);
    if (providerDraftId) {
      await deleteGraphUserDraft(api, providerDraftId);
      await query(
        'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3 AND provider_message_id = $4',
        [account.id, String(identity.uid), identity.folder, providerDraftId],
      );
    } else {
      await query(
        'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3',
        [account.id, String(identity.uid), identity.folder],
      );
    }
    return true;
  }

  // IMAP: only an identity confirmed by the folder's UIDVALIDITY may be removed; guessing
  // would risk expunging an unrelated message after the folder renumbered.
  const uidNumber = positiveInteger(identity.uid);
  const uidValidity = positiveInteger(identity.uidValidity);
  if (uidNumber === null || uidValidity === null) return false;
  const stored = await query<{ draft_uid_validity: number | string | null }>(
    'SELECT draft_uid_validity FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3',
    [account.id, String(identity.uid), identity.folder],
  );
  if (Number(stored.rows[0]?.draft_uid_validity) !== uidValidity) return false;
  await imapManager.permanentDeleteMessage(account, uidNumber, identity.folder, uidValidity);
  await query(
    'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3 AND draft_uid_validity = $4',
    [account.id, String(identity.uid), identity.folder, uidValidity],
  );
  return true;
}

/**
 * Consume every draft a delivered send supersedes: the composer's `existingDraft` identity
 * and/or an MCP compose flow's `draftMessageId` row. Each removal is independent and
 * non-fatal — a draft that survives here is what the next sync resurrects, but a cleanup
 * failure must never turn a delivered message into an error response.
 */
export async function consumeSentDrafts(userId: string, payload: { existingDraft?: unknown; draftMessageId?: unknown }): Promise<void> {
  const identities: SentDraftIdentity[] = [];
  const seen = new Set<string>();
  const add = (identity: SentDraftIdentity | null) => {
    if (!identity) return;
    const key = identityKey(identity);
    if (seen.has(key)) return;
    seen.add(key);
    identities.push(identity);
  };
  add(sentDraftIdentity(payload.existingDraft));
  if (typeof payload.draftMessageId === 'string' && payload.draftMessageId) {
    const rows = await query<{ account_id: string; uid: string | number; folder: string; draft_uid_validity: string | number | null }>(
      `SELECT m.account_id, m.uid, m.folder, m.draft_uid_validity
         FROM messages m JOIN email_accounts a ON a.id = m.account_id
        WHERE m.id = $1 AND a.user_id = $2`,
      [payload.draftMessageId, userId],
    );
    const row = rows.rows[0];
    if (row) add({ accountId: row.account_id, uid: row.uid, folder: row.folder, uidValidity: row.draft_uid_validity ?? null });
  }
  for (const identity of identities) {
    try {
      const consumed = await consumeSentDraft(userId, identity);
      if (!consumed) console.warn(`Send: draft cleanup for account ${identity.accountId} uid ${identity.uid} could not be confirmed; the sync will reconcile it`);
    } catch (caught) {
      console.error(`Send: draft cleanup failed for account ${identity.accountId} uid ${identity.uid}: ${toAppError(caught).message}`);
    }
  }
}
