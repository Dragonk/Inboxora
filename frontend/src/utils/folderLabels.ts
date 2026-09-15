// Translate presentation only. IMAP paths remain the identity used by every API,
// selection and move operation; custom folders and user labels stay untouched.

/** The folder fields folder labelling reads; API folder rows and synthetic { path } stubs both match. */
export interface FolderLike {
  path?: string | null;
  name?: string | null;
  special_use?: string | null;
  specialUse?: string | null;
}

export function folderRole(folder: FolderLike | null | undefined, mappings: Record<string, unknown> | null | undefined = {}) {
  const path = String(folder?.path || '');
  if (path.toLowerCase() === 'inbox') return 'inbox';
  for (const role of ['sent', 'drafts', 'trash', 'spam', 'archive']) {
    if (mappings?.[role] === path && path) return role;
  }
  const flags = String(folder?.special_use || folder?.specialUse || '').toLowerCase().split(/\s+/);
  const special: Record<string, string> = { '\\inbox': 'inbox', '\\sent': 'sent', '\\drafts': 'drafts', '\\trash': 'trash', '\\junk': 'spam', '\\spam': 'spam', '\\archive': 'archive', '\\all': 'all', '\\flagged': 'starred', '\\important': 'important' };
  for (const flag of flags) if (special[flag]) return special[flag];
  // Legacy servers may omit SPECIAL-USE. Only recognize exact conventional
  // paths and known provider namespaces, never arbitrary user-created subfolders.
  const canonical = path.toLowerCase().replace(/^(?:\[gmail\]|\[google mail\]|inbox)[/.]/, '');
  const canonicalRoles: Record<string, string> = { inbox: 'inbox', sent: 'sent', 'sent items': 'sent', 'sent mail': 'sent', draft: 'drafts', drafts: 'drafts', trash: 'trash', 'deleted items': 'trash', 'deleted messages': 'trash', spam: 'spam', junk: 'spam', 'junk email': 'spam', archive: 'archive', archives: 'archive', 'all mail': 'all', starred: 'starred', important: 'important' };
  return canonicalRoles[canonical] || null;
}

export function folderLabel(folder: FolderLike | null | undefined, t: (key: string) => string, mappings: Record<string, unknown> | null | undefined = undefined) {
  const labels: Record<string, () => string> = {
    inbox: () => t('mailFolders.inbox'), sent: () => t('mailFolders.sent'),
    drafts: () => t('mailFolders.drafts'), trash: () => t('mailFolders.trash'),
    spam: () => t('mailFolders.spam'), archive: () => t('mailFolders.archive'),
    all: () => t('mailFolders.all'), starred: () => t('mailFolders.starred'),
    important: () => t('mailFolders.important'),
  };
  const role = folderRole(folder, mappings);
  return (role ? labels[role]?.() : undefined) || folder?.name || folder?.path || '';
}
