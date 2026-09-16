import { api } from './api.ts';
import { useStore } from '../store/index.ts';
import { getAuthEpoch, isCurrentAuthEpoch, onAuthEpochChange } from './authEpoch.ts';

type PostSendRefreshInput = {
  accountId: string;
  threadId: string | null;
  threadCacheId: string | null;
  conversationId?: string;
};

type RefreshManagerDeps<TMessage> = {
  getAuthEpoch: () => number;
  isCurrentAuthEpoch: (epoch: number) => boolean;
  onAuthEpochChange: (listener: (epoch: number) => void) => () => void;
  getThread: (threadId: string, accountId: string) => Promise<{ messages?: TMessage[] }> ;
  setThreadMessages: (cacheId: string, messages: TMessage[]) => void;
  refreshConversation: (conversationId: string) => void;
  setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
};

/**
 * Owns post-send refreshes independently from a ComposeModal instance. Timers survive
 * normal modal unmounts, but both timers and in-flight responses are generation-scoped.
 */
export function createPostSendRefreshManager<TMessage>(deps: RefreshManagerDeps<TMessage>) {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const cancelPending = () => {
    timers.forEach(deps.clearTimer);
    timers.clear();
  };
  const unsubscribe = deps.onAuthEpochChange(cancelPending);

  const refresh = async (input: PostSendRefreshInput, epoch: number) => {
    if (!deps.isCurrentAuthEpoch(epoch)) return;
    if (input.conversationId) deps.refreshConversation(input.conversationId);
    if (!input.threadId) return;

    try {
      const data = await deps.getThread(input.threadId, input.accountId);
      if (!deps.isCurrentAuthEpoch(epoch)) return;
      const cacheId = input.threadCacheId || input.threadId;
      if (data.messages?.length) deps.setThreadMessages(cacheId, data.messages);
    } catch { /* best-effort refresh */ }
  };

  return {
    schedule(input: PostSendRefreshInput) {
      const epoch = deps.getAuthEpoch();
      void refresh(input, epoch);
      if (!input.threadId) return;
      for (const delay of [3000, 10000, 16000]) {
        const timer = deps.setTimer(() => {
          timers.delete(timer);
          void refresh(input, epoch);
        }, delay);
        timers.add(timer);
      }
    },
    dispose() {
      cancelPending();
      unsubscribe();
    },
  };
}

export const postSendRefreshManager = createPostSendRefreshManager({
  getAuthEpoch,
  isCurrentAuthEpoch,
  onAuthEpochChange,
  getThread: (threadId, accountId) => api.getThread(threadId, '', false, accountId),
  setThreadMessages: (cacheId, messages) => useStore.getState().setThreadMessages(cacheId, messages),
  refreshConversation: (conversationId) => {
    window.dispatchEvent(new CustomEvent('inboxora:conversation-refresh', { detail: { conversationId } }));
  },
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: clearTimeout,
});
