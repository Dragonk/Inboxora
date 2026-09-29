import { api } from './api.ts';
import { useStore } from '../store/index.ts';
let navigation = 0;
export async function openNotificationMessage(messageId: string, accountId: string, authEpoch: number): Promise<void> {
  const serial = ++navigation;
  const initial = useStore.getState();
  // The refresh token also records a repeated click on the same mailbox. Other
  // module/message/search choices must likewise win over a pending lookup.
  const navigationKeys = ['selectedAccountId', 'selectedFolder', 'selectedMessageId',
    'messagesRefreshToken', 'showAdmin', 'adminTab', 'showContacts', 'showCalendar',
    'showScheduled', 'searchQuery'] as const;
  let navigated = false;
  const unsubscribe = useStore.subscribe(state => {
    if (navigationKeys.some(key => state[key] !== initial[key])) navigated = true;
  });
  const current = () => !navigated && serial === navigation && useStore.getState().authEpoch === authEpoch
    && Boolean(useStore.getState().user) && !useStore.getState().isLocked;
  let message: Awaited<ReturnType<typeof api.resolveMessage>>;
  try {
    if (!current()) return;
    message = await api.resolveMessage(messageId, accountId);
  } catch (error) {
    if (current()) throw error;
    return;
  } finally {
    unsubscribe();
  }
  if (!current() || !message || typeof message.id !== 'string' || message.account_id !== accountId) return;
  const state = useStore.getState();
  state.setShowAdmin(false); state.setSearchQuery('');
  state.setSelectedAccount(accountId, typeof message.folder === 'string' ? message.folder : 'INBOX');
  useStore.setState(state => ({ messages: [message, ...state.messages.filter(item => item.id !== message.id)] }));
  state.setSelectedMessage(message.id);
  window.dispatchEvent(new Event('inboxora:refresh'));
}
