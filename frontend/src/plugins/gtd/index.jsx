// GTD plugin — frontend registrations (v3.0 plugin platform).
//
// Registers GTD's UI into core's plugin slots so core components carry no GTD-specific code. This is
// the frontend twin of backend/src/plugins/gtd. Imported for its side effects by plugins/index.js.
// (The GTD UI components/utils still live under components/ & utils/ for now; later slices relocate
// them wholesale into this directory.)
import { registerSlot } from '../registry.js';
import GtdSidebarContent from '../../components/GtdSidebarContent.jsx';
import { gtdActiveForContext } from '../../utils/gtd.js';

// Right-sidebar panel: GTD's triage rail. Live when GTD is on for the current account scope
// (per-user activation is already checked by the slot registry, so pass `true` here).
// ctx: { accounts, selectedAccountId, onCollapse, toggleHint }.
registerSlot('right-sidebar', {
  pluginId: 'gtd',
  isActive: (ctx) => gtdActiveForContext(ctx.accounts, ctx.selectedAccountId, true),
  render: (ctx) => <GtdSidebarContent onCollapse={ctx.onCollapse} toggleHint={ctx.toggleHint} />,
});
