import { GMAIL_USER, gmailGet } from './gmailApi.js';
import type { GoogleApiOptions } from './googleApiClient.js';

/**
 * Gmail **labels** as mail folders (P08, first slice).
 *
 * Gmail does not have folders. A message carries a set of label ids, a label is
 * identified by an immutable id, and its display name is what the user renames —
 * so this is not "Gmail pretending to be IMAP" and it is not "IMAP folders with a
 * different shape". Two consequences are deliberate:
 *
 *  - a **system** label that is a real mailbox in Gmail's own model (`INBOX`,
 *    `SENT`, `DRAFT`, `TRASH`, `SPAM`) maps onto Inboxora's canonical local path
 *    and the IMAP-style `special_use` the rest of the application reads, exactly
 *    as the Graph adapter does for Outlook's well-known folders. That is what
 *    keeps `folder === 'INBOX'`, the trash/drafts resolvers and the archive logic
 *    working for a Gmail API account;
 *  - a Gmail system label that is **not** a mailbox (`STARRED`, `IMPORTANT`,
 *    `UNREAD`, `CHAT`, `CATEGORY_*`) becomes no folder at all. Inventing an
 *    "Important" folder, or a folder per Gmail category, would present a
 *    structure the provider does not have and would make those labels look like
 *    places a message can be moved *to*.
 *
 * A user label **is** a folder, and its path is Gmail's own label name. Gmail
 * nests user labels with `/` (a nested label is literally named `Parent/Child`),
 * so `/` is the provider's delimiter and not one this adapter invented.
 *
 * A message has labels, plural. `messages` holds one row per provider message
 * (migration 0108's partial unique index), so the row carries the **primary**
 * folder this module picks and the complete label id set beside it
 * (`messages.provider_labels`, migration 0111). Nothing here invents a delimiter
 * path or a per-label copy.
 */

/**
 * A label as Gmail returns it. Only the fields this adapter reads are declared.
 *
 * `messagesTotal`/`messagesUnread` are the label's counts and become the local
 * folder's counters, so the sidebar badge matches the provider rather than the
 * (recently partial) local table.
 */
export interface GmailLabel {
  id: string;
  name?: string | null;
  /** `system` or `user`. A label without it is treated as a user label. */
  type?: string | null;
  messageListVisibility?: string | null;
  labelListVisibility?: string | null;
  messagesTotal?: number | null;
  messagesUnread?: number | null;
  threadsTotal?: number | null;
  threadsUnread?: number | null;
}

interface GmailLabelPage {
  labels?: GmailLabel[];
  nextPageToken?: string | null;
}

/** A folder as the local `folders` table models it. */
export interface LocalMailFolder {
  path: string;
  name: string;
  delimiter: string;
  specialUse: string | null;
  totalCount: number;
  unreadCount: number;
}

/** Gmail's own upper bound on labels per account; the page bound is separate. */
export const MAX_GMAIL_LABELS = 2000;
const LABEL_PAGE_SIZE = 500;
const MAX_LABEL_PAGES = 20;

/**
 * Gmail's system labels that are real mailboxes, projected onto the canonical
 * local path and the `special_use` the IMAP path already uses. A system label
 * keeps its canonical path whatever the user's language or display name is, which
 * is what makes the local folder stable.
 */
export const GMAIL_FOLDER_LABELS: Readonly<Record<string, { path: string; specialUse: string }>> = Object.freeze({
  INBOX: { path: 'INBOX', specialUse: '\\Inbox' },
  SENT: { path: 'Sent', specialUse: '\\Sent' },
  DRAFT: { path: 'Drafts', specialUse: '\\Drafts' },
  TRASH: { path: 'Trash', specialUse: '\\Trash' },
  SPAM: { path: 'Spam', specialUse: '\\Junk' },
});

/**
 * Gmail's system labels that are message attributes rather than mailboxes.
 *
 * They are listed explicitly instead of being inferred as "anything not in
 * `GMAIL_FOLDER_LABELS`" so a future system label is a visible decision: an
 * unlisted system label is neither a folder nor a silently ignored one — it is
 * still carried on the message's `provider_labels`, and {@link gmailLabelIsFolder}
 * refuses to make a folder out of it.
 */
export const GMAIL_MESSAGE_LABELS: readonly string[] = Object.freeze([
  'STARRED', 'IMPORTANT', 'UNREAD', 'CHAT',
]);

/** Whether a label id is a Gmail category label (`CATEGORY_PERSONAL`, …). */
export function isGmailCategoryLabel(id: string): boolean {
  return id.startsWith('CATEGORY_');
}

/**
 * Whether one Gmail label is a place a message can be *in* — the question that
 * decides whether it projects onto a local folder.
 */
export function gmailLabelIsFolder(label: GmailLabel): boolean {
  if (!label.id) return false;
  if (GMAIL_FOLDER_LABELS[label.id]) return true;
  if (label.type === 'user') return true;
  // A system label that is neither a known mailbox nor one of the declared
  // message attributes is not turned into a folder: doing so would present a
  // structure Gmail does not have.
  return false;
}

/** The local folder one Gmail label projects onto. Pure, so it can be asserted directly. */
export function localFolderForGmailLabel(label: GmailLabel): LocalMailFolder {
  const name = (label.name ?? '').trim() || label.id;
  const wellKnown = GMAIL_FOLDER_LABELS[label.id];
  return {
    path: wellKnown ? wellKnown.path : name,
    name,
    // Gmail's own hierarchy delimiter for nested user labels.
    delimiter: '/',
    specialUse: wellKnown?.specialUse ?? null,
    totalCount: Math.max(0, label.messagesTotal ?? 0),
    unreadCount: Math.max(0, label.messagesUnread ?? 0),
  };
}

/**
 * Map every folder-bearing label by its immutable id.
 *
 * The id is never derived from the name: a label renamed in Gmail is a rename of
 * the same local folder (and its messages move with it), not a new folder plus a
 * disappearance.
 *
 * A **canonical** path is never given up to a user label. Two labels can only
 * collide if the user's label is literally named like a system mailbox, and the
 * system label is the one the rest of the application addresses by path — so the
 * system label keeps it and the user label stays a message label (it is still on
 * each message's `provider_labels`). The same guard keeps two user labels that
 * differ only by something Gmail's namespace does not consider distinct out of
 * each other's local folder.
 */
export function gmailFolderPathMap(labels: readonly GmailLabel[]): Map<string, LocalMailFolder> {
  const mapped = new Map<string, LocalMailFolder>();
  const usedPaths = new Set<string>();
  const ordered = [...labels].sort((left, right) => {
    const leftSystem = GMAIL_FOLDER_LABELS[left.id] ? 0 : 1;
    const rightSystem = GMAIL_FOLDER_LABELS[right.id] ? 0 : 1;
    if (leftSystem !== rightSystem) return leftSystem - rightSystem;
    const leftName = (left.name ?? '').trim();
    const rightName = (right.name ?? '').trim();
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
  });
  for (const label of ordered) {
    if (!gmailLabelIsFolder(label)) continue;
    const local = localFolderForGmailLabel(label);
    if (usedPaths.has(local.path)) continue;
    usedPaths.add(local.path);
    mapped.set(label.id, local);
  }
  return mapped;
}

/**
 * Read the whole label list, paged.
 *
 * `labels.list` is a snapshot rather than a delta, which is the right shape here:
 * a label tree is small, and the run still takes the P03 sync lease so two passes
 * cannot interleave.
 */
export async function fetchGmailLabels(
  api: GoogleApiOptions,
  options: { maxLabels?: number } = {},
): Promise<{ labels: GmailLabel[]; complete: boolean }> {
  const maxLabels = options.maxLabels ?? MAX_GMAIL_LABELS;
  const labels: GmailLabel[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_LABEL_PAGES; page++) {
    const fetched: GmailLabelPage = await gmailGet<GmailLabelPage>(api, `users/${GMAIL_USER}/labels`, {
      maxResults: LABEL_PAGE_SIZE,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const label of fetched.labels ?? []) {
      if (!label.id) continue;
      labels.push(label);
      if (labels.length >= maxLabels) return { labels, complete: false };
    }
    pageToken = fetched.nextPageToken ?? null;
    if (!pageToken) break;
  }
  return { labels, complete: pageToken === null };
}

/**
 * The local folder path one message's label set gives it, or `null` when the
 * message is in no folder this account models.
 *
 * The precedence is a product decision stated once: a draft is a draft, a trashed
 * or spam message is shown where the user expects to find it, and an inbox message
 * is shown in the inbox even when it also carries `SENT` (a message sent to
 * oneself) or a user label. Anything else falls to the first of the message's
 * user labels in path order, so the row's folder is stable across runs rather than
 * depending on the order Gmail happened to list the ids in.
 *
 * `null` means the message is archived: it has no label that is a mailbox. That is
 * the same state the IMAP path models by keeping archived messages only in
 * Gmail's "All Mail", which Inboxora deliberately does not sync — so the caller
 * removes the local row instead of inventing an "Archive" folder Gmail has none
 * of.
 */
export function primaryFolderPathForGmailLabels(
  labelIds: readonly string[],
  pathByLabelId: ReadonlyMap<string, string>,
): string | null {
  if (labelIds.length === 0) return null;
  for (const preferred of ['DRAFT', 'TRASH', 'SPAM', 'INBOX', 'SENT'] as const) {
    if (!labelIds.includes(preferred)) continue;
    const path = pathByLabelId.get(preferred);
    if (path) return path;
  }
  // No system mailbox: the first user label in path order, so two runs agree.
  let best: string | null = null;
  for (const labelId of labelIds) {
    const path = pathByLabelId.get(labelId);
    if (path === undefined) continue;
    if (best === null || path < best) best = path;
  }
  return best;
}
