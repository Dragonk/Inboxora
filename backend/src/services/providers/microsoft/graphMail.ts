import { graphGet, graphUrl } from './graphApiClient.js';
import type { GraphApiOptions } from './graphApiClient.js';

/**
 * Microsoft Graph **mail** folders (P07b, read path).
 *
 * This is not "Graph pretending to be IMAP". Graph addresses a folder by an
 * immutable id, exposes its well-known role separately from its display name, and
 * nests folders through `childFolders` rather than through a delimiter — so the
 * adapter reads those semantics and maps them onto Inboxora's common folder model
 * (`folders.path` is the stable key every message row stores, `name` is what the
 * interface shows, `special_use` is what the trash/drafts/archive/spam resolvers
 * read).
 *
 * Two consequences worth stating, because both are deliberate:
 *
 *  - a well-known folder maps onto its **canonical local path** (`INBOX`, `Sent`,
 *    `Trash`, …), so the rest of the application keeps working for a Graph account
 *    exactly as it does for IMAP — including the code that compares `folder` to
 *    `INBOX`;
 *  - every other folder's path is derived from its display name, and its identity
 *    is the Graph id held in `integration_collections.remote_id`. A rename is
 *    therefore detected as a rename rather than as a new folder plus a deletion.
 */

/** The fields the folder adapter reads. Graph returns more; nothing else is used. */
export interface GraphMailFolder {
  id: string;
  displayName?: string | null;
  parentFolderId?: string | null;
  childFolderCount?: number | null;
  totalItemCount?: number | null;
  unreadItemCount?: number | null;
  /** Present on Outlook's well-known folders (`inbox`, `sentitems`, …). */
  wellKnownName?: string | null;
}

interface GraphFolderPage {
  value?: GraphMailFolder[];
  '@odata.nextLink'?: string;
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

const FOLDER_SELECT = 'id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount,wellKnownName';
const PAGE_SIZE = 100;
/** Graph nests folders; the bound keeps a malformed tree from being walked forever. */
const MAX_FOLDER_DEPTH = 10;
export const MAX_MAIL_FOLDERS = 2000;

/**
 * Outlook's well-known folders, mapped to Inboxora's canonical local paths and to
 * the IMAP-style `special_use` values the rest of the application already reads.
 * A well-known folder keeps its canonical path whatever its display name becomes,
 * which is what makes a renamed Inbox keep working.
 */
const WELL_KNOWN_FOLDERS: Readonly<Record<string, { path: string; specialUse: string }>> = Object.freeze({
  inbox: { path: 'INBOX', specialUse: '\\Inbox' },
  sentitems: { path: 'Sent', specialUse: '\\Sent' },
  drafts: { path: 'Drafts', specialUse: '\\Drafts' },
  deleteditems: { path: 'Trash', specialUse: '\\Trash' },
  junkemail: { path: 'Spam', specialUse: '\\Junk' },
  archive: { path: 'Archive', specialUse: '\\Archive' },
  outbox: { path: 'Outbox', specialUse: '\\Outbox' },
  conversationhistory: { path: 'Conversation History', specialUse: '\\All' },
});

/** The local folder a Graph folder projects onto. Pure, so it can be asserted directly. */
export function localFolderForGraphFolder(folder: GraphMailFolder, parentPath: string | null): LocalMailFolder {
  const name = (folder.displayName ?? '').trim() || folder.id;
  const wellKnown = folder.wellKnownName ? WELL_KNOWN_FOLDERS[folder.wellKnownName.toLowerCase()] : undefined;
  const path = wellKnown ? wellKnown.path : parentPath ? `${parentPath}/${name}` : name;
  return {
    path,
    name,
    delimiter: '/',
    specialUse: wellKnown?.specialUse ?? null,
    totalCount: Math.max(0, folder.totalItemCount ?? 0),
    unreadCount: Math.max(0, folder.unreadItemCount ?? 0),
  };
}

/**
 * Map every folder in a listing by its Graph id. A folder whose parent is not in
 * the listing is treated as a root, and a cycle is broken rather than followed.
 */
export function graphFolderPathMap(folders: readonly GraphMailFolder[]): Map<string, LocalMailFolder> {
  const byId = new Map<string, GraphMailFolder>();
  for (const folder of folders) if (folder.id) byId.set(folder.id, folder);

  const mapped = new Map<string, LocalMailFolder>();
  const resolving = new Set<string>();

  const resolve = (folder: GraphMailFolder): LocalMailFolder => {
    const existing = mapped.get(folder.id);
    if (existing) return existing;
    const parent = folder.parentFolderId ? byId.get(folder.parentFolderId) : undefined;
    let parentPath: string | null = null;
    if (parent && parent.id !== folder.id && !resolving.has(parent.id)) {
      resolving.add(folder.id);
      parentPath = resolve(parent).path;
      resolving.delete(folder.id);
    }
    const local = localFolderForGraphFolder(folder, parentPath);
    mapped.set(folder.id, local);
    return local;
  };

  for (const folder of folders) if (folder.id) resolve(folder);
  return mapped;
}

/**
 * Read the whole mail-folder tree of the signed-in mailbox, parents before
 * children. `$top` pages and `@odata.nextLink` are followed explicitly rather than
 * relying on Graph's default page size.
 */
export async function fetchMailFolders(
  api: GraphApiOptions,
  options: { maxFolders?: number } = {},
): Promise<GraphMailFolder[]> {
  const maxFolders = options.maxFolders ?? MAX_MAIL_FOLDERS;
  const folders: GraphMailFolder[] = [];
  const queue: Array<{ id: string | null; depth: number }> = [{ id: null, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth > MAX_FOLDER_DEPTH) continue;
    let nextLink: string | null = null;
    do {
      const page: GraphFolderPage = nextLink
        ? await graphGet<GraphFolderPage>(api, nextLink)
        : await graphGet<GraphFolderPage>(api, graphUrl(
          current.id ? `/me/mailFolders/${encodeURIComponent(current.id)}/childFolders` : '/me/mailFolders',
          { $top: PAGE_SIZE, $select: FOLDER_SELECT },
        ));
      for (const folder of page.value ?? []) {
        if (!folder.id) continue;
        folders.push(folder);
        if (folders.length >= maxFolders) return folders;
        if ((folder.childFolderCount ?? 0) > 0) queue.push({ id: folder.id, depth: current.depth + 1 });
      }
      nextLink = page['@odata.nextLink'] ?? null;
    } while (nextLink);
  }
  return folders;
}
