import { sanitizeFolderOrder } from '../utils/sidebar.ts';

const STORAGE_KEY = 'mailflow_folder_order';

interface FolderOrderPreferences {
  folderOrder?: unknown;
}

export function cacheFolderOrder(value: unknown, storage = localStorage) {
  const clean = sanitizeFolderOrder(value);
  storage.setItem(STORAGE_KEY, JSON.stringify(clean));
  return clean;
}

export function readFolderOrder(storage = localStorage) {
  try {
    return sanitizeFolderOrder(
      JSON.parse(storage.getItem(STORAGE_KEY) || '{}'),
    );
  } catch {
    return {};
  }
}

export function cacheFolderOrderFromPreferences(
  preferences: FolderOrderPreferences,
  storage = localStorage,
) {
  return cacheFolderOrder(preferences.folderOrder, storage);
}

export function mergeFolderOrder(
  current: unknown,
  accountId: string,
  paths: unknown,
  storage = localStorage,
) {
  return cacheFolderOrder({
    ...sanitizeFolderOrder(current),
    [accountId]: Array.isArray(paths) ? paths : [],
  }, storage);
}
