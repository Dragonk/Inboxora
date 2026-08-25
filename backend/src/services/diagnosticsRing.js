// In-memory diagnostics runtime counters for the diagnostics report (Phase 2).
//
// Holds a small ring of recently categorized warnings plus cumulative WebSocket
// and broadcast counters. Everything here is non-identifying by construction
// (category codes + counts + an optional raw account id that the report layer
// hashes with the per-report salt). Reset on process restart.

const WARN_CAP = 200;
const warnings = []; // { t, code, accountId | null }
const broadcastCounts = Object.create(null);
let wsConnects = 0;
let wsDisconnects = 0;
let currentSockets = 0;

export function recordWarning(code, accountId = null) {
  if (!code) return;
  warnings.push({ t: Date.now(), code, accountId: accountId || null });
  if (warnings.length > WARN_CAP) warnings.shift();
}

export function recordBroadcast(type) {
  if (!type) return;
  broadcastCounts[type] = (broadcastCounts[type] || 0) + 1;
}

export function recordWsConnect() {
  wsConnects += 1;
  currentSockets += 1;
}

export function recordWsDisconnect() {
  wsDisconnects += 1;
  currentSockets = Math.max(0, currentSockets - 1);
}

// Aggregate the raw warning ring by (code, accountId): count + last-seen time.
// The report layer filters by the requesting user's accounts and hashes the id.
export function getWarningsRaw() {
  const agg = new Map();
  for (const w of warnings) {
    const key = `${w.code}|${w.accountId || ''}`;
    const e = agg.get(key) || { code: w.code, accountId: w.accountId, count: 0, lastT: 0 };
    e.count += 1;
    e.lastT = Math.max(e.lastT, w.t);
    agg.set(key, e);
  }
  return [...agg.values()].sort((a, b) => b.lastT - a.lastT);
}

export function getConnectionStats() {
  return { wsConnects, wsDisconnects, currentSockets, broadcastCounts: { ...broadcastCounts } };
}

// Test-only reset.
export function _resetDiagnosticsRing() {
  warnings.length = 0;
  for (const k of Object.keys(broadcastCounts)) delete broadcastCounts[k];
  wsConnects = 0;
  wsDisconnects = 0;
  currentSockets = 0;
}
