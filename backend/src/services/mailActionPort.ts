import { query } from './db.js';
import { googleConfigFromEnv, microsoftConfigFromEnv } from './providerAuthService.js';
import { moveGmailMessageToLabel } from './providers/google/gmailMailMove.js';
import { deleteGmailMessagePermanently } from './providers/google/gmailMailMutations.js';
import { moveGraphMessageToFolder, deleteGraphMessagePermanently } from './providers/microsoft/graphMailMove.js';
import { pushGmailMessageFlag, pushGraphMessageFlag } from './providerMailFlagWrite.js';
import type { ImapManager } from './imapManager.js';
import type { EmailAccountRow } from './imapManager.js';

/**
 * The message actions the ingest rules perform, as a seam a transport can implement (MAIL-01).
 *
 * The rules and the block list were written against `ImapManager` itself, so they could only ever run for an
 * IMAP account: `move`, `setFlag` and the move guards all take an IMAP `uid` and a folder path. Extracting what
 * they actually *do* — move a message, flag it, delete it, keep two concurrent moves of the same message apart —
 * lets the same engine run over a provider, which needs the same actions expressed through Gmail's or Graph's
 * API.
 *
 * The members are **exactly** the `ImapManager` methods the engine already calls, with the same shapes, so an
 * `ImapManager` satisfies this interface structurally: wiring the port in changed no IMAP call site and no
 * behaviour. A provider implementation resolves the local `uid` to the message's provider identity itself.
 */
export interface MailActionPort {
  /** Marks a message as being moved, so a concurrent flag update does not fight the move. */
  _guardMoveUid(accountId: string, folder: string, uid: number | string): void;
  _unguardMoveUid(accountId: string, folder: string, uid: number | string): void;
  /** Queues a flag change so it reaches the provider that owns the message. */
  _enqueueFlagPush(accountId: string, messageId: string, flag: string, value: boolean): void;
  bulkMoveMessages(
    account: EmailAccountRow,
    uids: Array<number | string>,
    fromFolder: string,
    toFolder: string,
  ): Promise<{ uidMap?: Map<number, number>; succeeded?: unknown[]; failed?: unknown[] }>;
  setFlag(account: EmailAccountRow, uid: number | string, folder: string, flag: string, value: boolean): Promise<unknown>;
  /**
   * Reading a message's bytes, which a rule that forwards needs.
   *
   * It belongs to the same seam: the transport that owns the message decides where its bytes are read from, and
   * `ruleForwarder` refuses a transport it has no reader for rather than falling back to IMAP.
   */
  fetchMessageBody(
    account: EmailAccountRow,
    uid: number | string,
    folder: string,
  ): Promise<{ text?: string | null; html?: string | null; attachments?: unknown }>;
  fetchMultipleAttachments(
    account: EmailAccountRow,
    uid: number | string,
    folder: string,
    parts: Array<{ part: string; filename?: string; type?: string; encoding?: string; size?: number; [key: string]: unknown }>,
  ): Promise<Map<string, Buffer>>;
}

/**
 * The IMAP implementation: the manager itself.
 *
 * It exists as a named function rather than passing the manager directly, so the seam is visible at the call
 * site and a reader can see that this is the port, not a special case.
 */
export function imapMailActionPort(manager: ImapManager): MailActionPort {
  return manager;
}

/**
 * The provider implementation: the same actions over Gmail's or Graph's API.
 *
 * The engine addresses a message by its IMAP-shaped `uid` and folder, which a provider message does not have as
 * an identity, so the port resolves the local row from that pair and then acts by the provider's own id. The
 * Gmail and Graph move/delete/flag services already exist and already run on the mutation journal; this port is
 * the resolution and the dispatch, not a second write path.
 */
export function providerMailActionPort(input: {
  userId: string;
  /** The account row: its id, transport and provider connection decide which service runs. */
  account: EmailAccountRow;
  connectionId: string;
}): MailActionPort {
  const transport = input.account.mail_transport === 'gmail_api' ? 'gmail_api' : 'microsoft_graph';
  const guards = new Map<string, number>();
  const guardKey = (accountId: string, folder: string, uid: number | string) => `${accountId}:${folder}:${uid}`;

  /** The local row a provider action needs: its own id and the provider's identity for the message. */
  const resolve = async (accountId: string, uid: number | string, folder: string) => {
    const found = await query<{ id: string; provider_message_id: string | null }>(
      `SELECT id, provider_message_id FROM messages
        WHERE account_id = $1 AND uid = $2 AND provider_message_id IS NOT NULL
        ORDER BY (folder = $3) DESC, synced_at DESC NULLS LAST
        LIMIT 1`,
      [accountId, uid, folder],
    );
    return found.rows[0] ?? null;
  };

  return {
    _guardMoveUid(accountId, folder, uid) {
      const key = guardKey(accountId, folder, uid);
      guards.set(key, (guards.get(key) ?? 0) + 1);
    },
    _unguardMoveUid(accountId, folder, uid) {
      const key = guardKey(accountId, folder, uid);
      const remaining = (guards.get(key) ?? 0) - 1;
      if (remaining > 0) guards.set(key, remaining);
      else guards.delete(key);
    },
    _enqueueFlagPush() {
      // The IMAP reconciler writes over IMAP, so it must never be handed a provider change. A provider flag write
      // schedules its own retry on the mutation journal (`retry: { delaySeconds: 300 }`), which is where this
      // queue's job already lives for a native account.
    },
    async bulkMoveMessages(account, uids, fromFolder, toFolder) {
      const succeeded: Array<number | string> = [];
      const failed: Array<number | string> = [];
      for (const uid of uids) {
        const row = await resolve(account.id, uid, fromFolder);
        if (!row?.provider_message_id) {
          failed.push(uid);
          continue;
        }
        if (transport === 'gmail_api') {
          const moved = await moveGmailMessageToLabel({
            userId: input.userId, accountId: account.id, connectionId: input.connectionId,
            config: googleConfigFromEnv(), resourceId: row.id,
            providerMessageId: row.provider_message_id, destinationPath: toFolder, sourcePath: fromFolder,
          });
          if (!moved.moved) { failed.push(uid); continue; }
        } else {
          const moved = await moveGraphMessageToFolder({
            userId: input.userId, accountId: account.id, connectionId: input.connectionId,
            config: microsoftConfigFromEnv(), resourceId: row.id,
            providerMessageId: row.provider_message_id, destinationPath: toFolder,
          });
          if (!moved.moved) { failed.push(uid); continue; }
          // Graph gives a moved item a **new** id, so the local row has to carry it: without this the next delta
          // would not recognise the message and would insert a second copy of it.
          await query('UPDATE messages SET provider_message_id = $1 WHERE id = $2', [moved.newProviderMessageId, row.id]);
        }
        await query('UPDATE messages SET folder = $1, synced_at = NOW() WHERE id = $2', [toFolder, row.id]);
        succeeded.push(uid);
      }
      // No `uidMap`: a provider message's local uid is re-derived by the next sync, so there is no new number to
      // report. The engine then writes the new folder itself, which is the same write this made.
      return { uidMap: new Map(), succeeded, failed };
    },
    async setFlag(account, uid, folder, flag, value) {
      const row = await resolve(account.id, uid, folder);
      if (!row?.provider_message_id) return false;
      const providerMessageId = row.provider_message_id;
      // `\Deleted` is not a flag on a provider — it is the expunge the block list asks for, and the provider's
      // own delete is the action that means it.
      if (flag === '\\Deleted') {
        if (!value) return true;
        const removed = transport === 'gmail_api'
          ? await deleteGmailMessagePermanently({
            userId: input.userId, accountId: account.id, connectionId: input.connectionId,
            config: googleConfigFromEnv(), resourceId: row.id, providerMessageId,
          })
          : await deleteGraphMessagePermanently({
            userId: input.userId, accountId: account.id, connectionId: input.connectionId,
            config: microsoftConfigFromEnv(), resourceId: row.id, providerMessageId,
          });
        return removed.deleted;
      }
      const written = transport === 'gmail_api'
        ? await pushGmailMessageFlag({
          userId: input.userId, account: input.account, accountId: account.id,
          messageId: row.id, providerMessageId, flag, value,
        })
        : await pushGraphMessageFlag({
          userId: input.userId, account: input.account, accountId: account.id,
          messageId: row.id, providerMessageId, flag, value,
        });
      return written.status === 'confirmed' || written.status === 'accepted';
    },
    async fetchMessageBody() {
      // Never reached for a native account: `ruleForwarder` reads a Graph or Gmail body through that provider's
      // own reader, and calls this only for `imap_smtp`. Failing loudly beats returning an empty body, which
      // would forward a message with its content silently missing.
      throw new Error('A native account reads a message body through its provider, not through the mail-action port');
    },
    async fetchMultipleAttachments() {
      throw new Error('A native account reads attachments through its provider, not through the mail-action port');
    },
  };
}
