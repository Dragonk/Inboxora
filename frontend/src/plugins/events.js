// Frontend plugin behaviour registrations (v3.0 plugin platform — frontend half).
//
// Slots (registry.js / PluginSlot.jsx) cover UI a plugin RENDERS. This covers BEHAVIOUR a plugin
// runs outside React's render cycle — WebSocket message handlers and reconnect hooks — so core's
// useWebSocket carries no plugin-specific code. Handlers run only while the plugin is activated for
// the user (store.enabledPlugins); they receive plain data and read state via useStore.getState()
// themselves (they are NOT React hooks). A throwing handler is isolated so it can't break the socket.
import { useStore } from '../store/index.js';

const wsHandlers = new Map(); // messageType -> [{ pluginId, handler }]
const reconnectHandlers = []; // [{ pluginId, handler }]

const isActivated = (pluginId) => useStore.getState().enabledPlugins.includes(pluginId);

export function registerWsHandler(messageType, { pluginId, handler }) {
  const list = wsHandlers.get(messageType) || [];
  list.push({ pluginId, handler });
  wsHandlers.set(messageType, list);
}

export function registerReconnectHandler({ pluginId, handler }) {
  reconnectHandlers.push({ pluginId, handler });
}

// Dispatch a WS message to any activated plugin registered for its type. Core calls this for
// message types it does not handle itself (the switch default). Returns true if a handler ran.
export function dispatchPluginWsMessage(data) {
  let handled = false;
  for (const { pluginId, handler } of wsHandlers.get(data?.type) || []) {
    if (!isActivated(pluginId)) continue;
    try { handler(data); handled = true; } catch (err) { console.error(`plugin ws handler ${pluginId}/${data.type} failed:`, err); }
  }
  return handled;
}

// Run every activated plugin's reconnect hook. Core calls this on socket (re)open — events missed
// during the outage aren't buffered, so a plugin can resync.
export function dispatchPluginReconnect() {
  for (const { pluginId, handler } of reconnectHandlers) {
    if (!isActivated(pluginId)) continue;
    try { handler(); } catch (err) { console.error(`plugin reconnect handler ${pluginId} failed:`, err); }
  }
}
