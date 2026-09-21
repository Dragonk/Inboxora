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
