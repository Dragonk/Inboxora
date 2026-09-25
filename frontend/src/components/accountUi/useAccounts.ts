import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api.ts';
import { useStore } from '../../store/index.ts';
import type { AccountProviderStatusSnapshot } from '../AccountProviderServices.tsx';

export type ServiceSnapshot = AccountProviderStatusSnapshot & {
  calendar: (NonNullable<AccountProviderStatusSnapshot['calendar']> & { calendarManagement?: { authorized?: boolean; missingScopes?: string[] } }) | null;
};
export function useProviderAccounts() {
  const accounts = useStore(state => state.accounts); const epoch = useStore(state => state.authEpoch);
  const ids = accounts.map(account => account.id).sort().join(',');
  const [snapshots, setSnapshots] = useState<Record<string, ServiceSnapshot>>({});
  const [failures, setFailures] = useState<string[]>([]); const [loading, setLoading] = useState(true);
  const generation = useRef(0); const mounted = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++generation.current; const accountIds = ids ? ids.split(',') : [];
    setLoading(true);
    const results = await Promise.all(accountIds.map(async accountId => {
      try {
        const [snapshot, capabilities] = await Promise.all([
          api.accountProviderStatus(accountId) as Promise<ServiceSnapshot>,
          api.accountProviderFeatures(accountId).catch(() => null) as Promise<ServiceSnapshot | null>,
        ]);
        if (snapshot.calendar && capabilities?.accountId === accountId && capabilities.calendar?.calendarManagement) snapshot.calendar = { ...snapshot.calendar, calendarManagement: capabilities.calendar.calendarManagement };
        return { accountId, snapshot };
      }
      catch { return { accountId, snapshot: null }; }
    }));
    if (!mounted.current || request !== generation.current || useStore.getState().authEpoch !== epoch) return;
    const next: Record<string, ServiceSnapshot> = {}; const failed: string[] = [];
    for (const result of results) {
      if (result.snapshot?.accountId === result.accountId) next[result.accountId] = result.snapshot;
      else failed.push(result.accountId);
    }
    setSnapshots(next); setFailures(failed); setLoading(false);
  }, [epoch, ids]);
  useEffect(() => {
    mounted.current = true; setSnapshots({}); setFailures([]); void refresh();
    const changed = () => { void refresh(); };
    window.addEventListener('inboxora:provider-sync-completed', changed);
    const cancel = () => { mounted.current = false; generation.current++; };
    return () => { cancel(); window.removeEventListener('inboxora:provider-sync-completed', changed); };
  }, [refresh]);
  return { accounts, accountIdsKey: ids, snapshots, failures, loading, refresh };
}
export function useAccountOperation() {
  const epoch = useStore(state => state.authEpoch); const scope = useRef(0); const lock = useRef(false);
  const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false);
  useEffect(() => { scope.current++; lock.current = false; setBusy(false); setFailed(false); const cancel = () => { scope.current++; }; return cancel; }, [epoch]);
  const run = async (operation: (current: () => boolean) => Promise<void>): Promise<boolean> => {
    if (lock.current || useStore.getState().authEpoch !== epoch) return false;
    const generation = scope.current; const current = () => generation === scope.current && useStore.getState().authEpoch === epoch;
    lock.current = true; setBusy(true); setFailed(false);
    try { await operation(current); return current(); }
    catch { if (current()) setFailed(true); return false; }
    finally { if (current()) { lock.current = false; setBusy(false); } }
  };
  return { busy, failed, setFailed, run };
}
