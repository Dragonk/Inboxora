import { useEffect } from 'react';
import { useStore } from '../../store/index.js';
import { gtdActiveForContext } from '../../utils/gtd.js';

// GTD's headless runtime: the single owner of the GTD sections fetch. Reloads whenever the context
// (unified vs a single account) changes and GTD is active there; both the rail and the tab list read
// the resulting store slice, and live updates arrive via the WS handler (plugins/events). Mounted by
// <PluginRuntime/> only while GTD is activated, so activation is already gated — pass `true` here.
export default function GtdRuntime() {
  const accounts = useStore(s => s.accounts);
  const selectedAccountId = useStore(s => s.selectedAccountId);
  const fetchGtdSections = useStore(s => s.fetchGtdSections);

  const gtdActive = gtdActiveForContext(accounts, selectedAccountId, true);
  // Also key on the set of GTD-enabled accounts so enabling a second account refetches the unified
  // sections — gtdActive alone stays true and wouldn't retrigger the one→two flip.
  const gtdEnabledKey = accounts.filter(a => a.gtd_enabled).map(a => a.id).sort().join(',');
  useEffect(() => {
    if (gtdActive) fetchGtdSections();
  }, [gtdActive, selectedAccountId, gtdEnabledKey, fetchGtdSections]);

  return null;
}
