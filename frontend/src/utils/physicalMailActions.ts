import type { StoreMessageRow, StoreState } from '../store/index.ts';
import { api } from './api.ts';
import { isInboxPhysicalMessage } from './mailFlagIntents.ts';
import { clearReadGuards, setPending, setCompletedRead } from './pendingReads.ts';
import { queueReadStateMutation, pendingReadState, isLatestReadStateMutation } from './readStateMutation.ts';
import { queueStarStateMutation, pendingStarState, isLatestStarStateMutation } from './starStateMutation.ts';
import { mailMutationStatus, mailMutationFailure, mutationNotice, type MailMutationStatus } from './mailMutationOutcome.ts';

type ActionState = Pick<StoreState, 'authEpoch' | 'isLocked' | 'selectedAccountId' | 'selectedFolder'
  | 'updateMessage' | 'decrementUnread' | 'incrementUnread' | 'adjustCategoryCount' | 'adjustFolderUnread' | 'addNotification'>;
interface ActionPorts {
  getState: () => ActionState;
  read?: (id: string, read: boolean, accountId: string) => Promise<unknown>;
  star?: (id: string, starred: boolean) => Promise<unknown>;
  refresh: (accountId: string) => void;
}

/** Shared physical-copy actions for pane navigation, deep links and detached views. */
export function createPhysicalMailActions(ports: ActionPorts) {
  const refresh = ports.refresh;
  const current = (epoch: number) => ports.getState().authEpoch === epoch && !ports.getState().isLocked;
  const adjustReadCounts = (message: StoreMessageRow, delta: number) => {
    const state = ports.getState();
    const folders = new Set([message.folder, ...(Array.isArray(message.folder_paths) ? message.folder_paths : [])]
      .filter((path): path is string => typeof path === 'string' && path.length > 0));
    if (message.is_archived === true) folders.delete('INBOX');
    for (const folder of folders) state.adjustFolderUnread(message.account_id, folder, delta);
    if (isInboxPhysicalMessage(message)) {
      if (delta < 0) state.decrementUnread(message.account_id, -delta);
      else state.incrementUnread(message.account_id, delta);
      if ((!state.selectedAccountId || state.selectedAccountId === message.account_id)
        && (!state.selectedAccountId || state.selectedFolder === 'INBOX')) {
        state.adjustCategoryCount(message.category, delta);
      }
    }
  };
  return {
    async read(message: StoreMessageRow, read: boolean): Promise<MailMutationStatus> {
      const state = ports.getState();
      const epoch = state.authEpoch;
      if (state.isLocked) return 'failed';
      const before = pendingReadState(message.id) ?? (typeof message.physical_is_read === 'boolean'
        ? message.physical_is_read : Boolean(message.is_read));
      const mutation = queueReadStateMutation(message.id, read, value => ports.read
        ? ports.read(message.id, value, message.account_id) : api.bulkRead([message.id], value, [message.account_id]));
      state.updateMessage(message.id, { is_read: read }, message.account_id);
      if (before !== read) adjustReadCounts(message, read ? -1 : 1);
      if (read && isInboxPhysicalMessage(message)) setPending(message.id, message.account_id);
      else clearReadGuards(message.id);
      let status: MailMutationStatus;
      try { status = mailMutationStatus(await mutation.promise, message.id); }
      catch (error) { status = mailMutationFailure(error); }
      if (!current(epoch) || !isLatestReadStateMutation(message.id, mutation.version)) return status;
      if (status === 'failed') {
        ports.getState().updateMessage(message.id, { is_read: before }, message.account_id);
        if (before !== read) adjustReadCounts(message, read ? 1 : -1);
      }
      if (status !== 'pending') clearReadGuards(message.id);
      if (status === 'confirmed' && read && isInboxPhysicalMessage(message)) setCompletedRead(message.id, message.account_id);
      if (status !== 'confirmed') ports.getState().addNotification(mutationNotice(status));
      // An authoritative readback may disagree with an uncertain write. Never
      // retain optimism until an unrelated change happens to produce equality.
      refresh(message.account_id);
      return status;
    },
    async star(message: StoreMessageRow, starred: boolean): Promise<MailMutationStatus> {
      const state = ports.getState();
      const epoch = state.authEpoch;
      if (state.isLocked) return 'failed';
      const before = pendingStarState(message.id) ?? Boolean(message.is_starred);
      const mutation = queueStarStateMutation(message.id, starred, value => ports.star
        ? ports.star(message.id, value) : api.markStarred(message.id, value));
      state.updateMessage(message.id, { is_starred: starred }, message.account_id);
      let status: MailMutationStatus;
      try { status = mailMutationStatus(await mutation.promise, message.id); }
      catch (error) { status = mailMutationFailure(error); }
      if (!current(epoch) || !isLatestStarStateMutation(message.id, mutation.version)) return status;
      if (status === 'failed') ports.getState().updateMessage(message.id, { is_starred: before }, message.account_id);
      if (status !== 'confirmed') ports.getState().addNotification(mutationNotice(status));
      refresh(message.account_id);
      return status;
    },
  };
}
