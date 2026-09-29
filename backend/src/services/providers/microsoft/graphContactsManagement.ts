import { graphGet, graphDeleteResponse, graphUrl, type GraphApiOptions } from './graphApiClient.js';
import { DEFAULT_GRAPH_CONTACTS_TARGET } from './graphContacts.js';

export type GraphAddressBookProtection = { canDelete: true } | { canDelete: false; reason: string };

/** v1 contactFolder has no default flag. A contact's parentFolderId is stable provider evidence. */
export async function inspectGraphAddressBookDeletion(api: GraphApiOptions, folderId: string): Promise<GraphAddressBookProtection> {
  if (!folderId.trim() || folderId !== folderId.trim() || folderId === '.' || folderId === '..') return { canDelete: false, reason: 'The provider folder identity is invalid.' };
  if (folderId === DEFAULT_GRAPH_CONTACTS_TARGET || folderId === 'contacts') return { canDelete: false, reason: 'The default Microsoft address book cannot be deleted.' };
  const primary = await graphGet<{ value?: Array<{ parentFolderId?: unknown }> }>(api, graphUrl('/me/contacts', { $select: 'parentFolderId', $top: 1 }));
  const defaultId = primary?.value?.[0]?.parentFolderId;
  if (typeof defaultId !== 'string' || !defaultId.trim()) return { canDelete: false, reason: 'Microsoft has not provided the default folder identity. Deletion is unavailable while the default address book is empty.' };
  if (folderId === defaultId) return { canDelete: false, reason: 'The default Microsoft address book cannot be deleted.' };
  const folder = await graphGet<{ id?: unknown }>(api, graphUrl(`/me/contactFolders/${encodeURIComponent(folderId)}`, { $select: 'id' }));
  if (folder?.id !== folderId) return { canDelete: false, reason: 'Microsoft did not confirm this folder belongs to the connected mailbox.' };
  return { canDelete: true };
}

export class GraphAddressBookProtectionError extends Error {
  constructor(message: string) { super(message); }
}

/** Deleting contacts individually is never a substitute for deleting a collection. */
export async function deleteGraphAddressBook(api: GraphApiOptions, folderId: string): Promise<void> {
  const protection = await inspectGraphAddressBookDeletion(api, folderId);
  if (!protection.canDelete) throw new GraphAddressBookProtectionError(protection.reason);
  const response = await graphDeleteResponse(api, graphUrl(`/me/contactFolders/${encodeURIComponent(folderId)}`, {}));
  if (response.status !== 204) throw new Error('Microsoft did not definitively confirm the address book deletion');
}
