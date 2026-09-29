import { api } from './api.ts';
import { useStore } from '../store/index.ts';
let navigation = 0;
export async function openNotificationMessage(messageId: string, accountId: string, authEpoch: number): Promise<void> {
  const serial = ++navigation;
  const current = () => serial === navigation && useStore.getState().authEpoch === authEpoch
    && Boolean(useStore.getState().user) && !useStore.getState().isLocked;
  if (!current()) return;
  const message = await api.resolveMessage(messageId, accountId);
  if (!current() || !message || typeof message.id !== 'string' || message.account_id !== accountId) return;
  const state = useStore.getState();
  state.setShowAdmin(false); state.setSearchQuery('');
  state.setSelectedAccount(accountId, typeof message.folder === 'string' ? message.folder : 'INBOX');
  useStore.setState(state => ({ messages: [message, ...state.messages.filter(item => item.id !== message.id)] }));
  state.setSelectedMessage(message.id);
  window.dispatchEvent(new Event('inboxora:refresh'));
}
