import { api } from './api.js';
import { useStore } from '../store/index.js';
import { pendingMarkReadMap } from './pendingReads.js';
import { accountAffectsUnifiedInbox } from './unifiedInbox.js';
import { recordDiagEvent } from './diagEvents.js';

// Apply a fresh server count, guarding against double-adjustment of in-flight
// mark-read operations.
//
// Since /unread-counts now queries messages directly, the DB reflects a
// mark-read as soon as the PATCH's UPDATE commits — which happens well before
// IMAP flag work finishes and before the HTTP response returns. This means
// pendingMarkReadMap can lag the DB by hundreds of milliseconds, and naively
// subtracting it from the server count would undercount by one per in-flight read.
//
// Guard: only subtract pending reads when the server count is still at least
// (current optimistic + pending size). If the server count is already lower,
// the DB has applied those reads and subtracting again would double-count.
function _applyServerCounts(counts) {
  const _before = useStore.getState().unreadCounts.total;
  if (pendingMarkReadMap.size > 0) {
    const state = useStore.getState();
    const current = state.unreadCounts;
    const pendingUnifiedCount = [...pendingMarkReadMap.values()]
      .filter(accountId => accountAffectsUnifiedInbox(state.accounts, accountId))
      .length;
    if (counts.total >= current.total + pendingUnifiedCount) {
      // Server hasn't incorporated in-flight reads yet — subtract them.
      const byAccount = { ...counts.byAccount };
      for (const accountId of pendingMarkReadMap.values()) {
        if (byAccount[accountId] > 0) byAccount[accountId]--;
      }
      const total = Math.max(0, counts.total - pendingUnifiedCount);
      useStore.setState({ unreadCounts: { total, byAccount } });
    } else {
      // DB already applied the reads — use the authoritative count directly.
      useStore.setState({ unreadCounts: counts });
    }
  } else {
    useStore.setState({ unreadCounts: counts });
  }
  recordDiagEvent({ category: 'unread', cause: 'server_counts', beforeTotal: _before, afterTotal: useStore.getState().unreadCounts.total });
}


let requestVersion = 0;
export async function refreshUnreadCounts() {
  const version = ++requestVersion;
  const before = useStore.getState().unreadCounts;
  try {
    const counts = await api.getUnreadCounts();
    // A newer request or optimistic mutation owns the UI now.
    if (version !== requestVersion || before !== useStore.getState().unreadCounts) return;
    _applyServerCounts(counts);
  } catch { /* Reconnect, next arrival or explicit refresh retries. */ }
}
