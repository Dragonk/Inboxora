import { useEffect, useRef } from 'react';
import { useStore } from '../../store/index.ts';

export type SettingsTarget =
  | { module: 'accounts'; accountId?: string; section?: 'general' | 'services' | 'servers' | 'diagnostics'; add?: boolean }
  | { module: 'calendar'; section: 'accounts' | 'resources' | 'import'; accountId?: string; sourceId?: string; resourceId?: string }
  | { module: 'contacts'; section: 'accounts' | 'resources' | 'import'; accountId?: string; sourceId?: string; resourceId?: string }
  | { module: 'integrations'; provider?: 'google' | 'microsoft' };
type Request = { target: SettingsTarget; authEpoch: number; serial: number };
let current: Request | null = null;
let serial = 0;
const listeners = new Set<() => void>();
// A pending target survives the mount of AdminPanel; a synchronous DOM event did not.
useStore.subscribe((state, previous) => {
  if (state.authEpoch !== previous.authEpoch || (!state.showAdmin && previous.showAdmin) || (state.adminTab !== previous.adminTab && current?.target.module !== state.adminTab)) current = null;
});
export function openSettings(target: SettingsTarget): void {
  const state = useStore.getState();
  current = { target, authEpoch: state.authEpoch, serial: ++serial };
  state.setAdminTab(target.module);
  state.setShowAdmin(true);
  listeners.forEach(listener => listener());
}
export function useSettingsTarget(module: SettingsTarget['module'], receive: (target: SettingsTarget) => void): void {
  const callback = useRef(receive); callback.current = receive;
  const last = useRef<number | null>(null);
  const epoch = useStore(state => state.authEpoch);
  useEffect(() => {
    const read = () => {
      const request = current;
      if (!request || request.authEpoch !== useStore.getState().authEpoch || request.target.module !== module || last.current === request.serial) return;
      last.current = request.serial;
      callback.current(request.target);
    };
    listeners.add(read); read();
    return () => { listeners.delete(read); };
  }, [module, epoch]);
}

export function isCurrentSettingsTarget(target: SettingsTarget): boolean {
  const state = useStore.getState();
  return current?.target === target && current.authEpoch === state.authEpoch && state.showAdmin && state.adminTab === target.module;
}
