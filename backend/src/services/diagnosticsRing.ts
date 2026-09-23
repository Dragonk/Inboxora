// In-memory diagnostics runtime counters for the diagnostics report (Phase 2).
//
// Holds a small ring of recently categorized warnings plus cumulative WebSocket
// and broadcast counters. Everything here is non-identifying by construction
// (category codes + counts + an optional raw account id that the report layer
// hashes with the per-report salt). Reset on process restart.

interface Warning {
  t: number;
  code: string;
  accountId: string | null;
}

interface WarningAggregate {
  code: string;
  accountId: string | null;
  count: number;
  lastT: number;
}

interface SyncSignal {
  sig: string;
  accountId: string | null;
  count: number;
  lastT: number;
  sumMag: number;
  maxMag: number;
}

type SyncSignalInput = Readonly<Record<string, string | number | null | undefined>>;

/** Redacted reply-path observation: no subject, recipient, row/provider identifier or content. */
export interface ReplyDiagnosticEvent {
  event: 'mail_reply_resolution' | 'mail_reply_ingested';
  accountId: string | null;
  transport: 'smtp' | 'gmail_api' | 'microsoft_graph';
  sendKind: 'reply' | 'reply_all';
  replyParentPresent: boolean;
  parentRfcMessageIdPresent: boolean;
  referencesCount: number;
  providerParentResolved: boolean;
  providerResolution: 'direct' | 'legacy_alias' | 'not_applicable' | 'unresolved';
  transportReplyMode: 'rfc_headers' | 'graph_create_reply' | 'graph_create_reply_all';
  t: number;
}

const WARN_CAP = 200;
const warnings: Warning[] = [];
const replyEvents: ReplyDiagnosticEvent[] = [];
const broadcastCounts: Record<string, number> = Object.create(null);
let wsConnects = 0;
let wsDisconnects = 0;
let currentSockets = 0;

export function recordWarning(code: string): void;
export function recordWarning(code: string, accountId: string | null | undefined): void;
export function recordWarning(code: string, ...accountIds: [] | [string | null | undefined]): void {
  if (!code) return;
  const accountId = accountIds[0];
  warnings.push({ t: Date.now(), code, accountId: accountId || null });
  if (warnings.length > WARN_CAP) warnings.shift();
}

export function recordReplyDiagnostic(event: Omit<ReplyDiagnosticEvent, 't'>): void {
  replyEvents.push({ ...event, t: Date.now() });
  if (replyEvents.length > WARN_CAP) replyEvents.shift();
}

export function getReplyDiagnosticsRaw(): ReplyDiagnosticEvent[] {
  return replyEvents.map(event => ({ ...event }));
}

export function recordBroadcast(type: string | null | undefined): void {
  if (!type) return;
  broadcastCounts[type] = (broadcastCounts[type] ?? 0) + 1;
}

// Sync-consistency signals (Phase 1 reliability instrumentation): cumulative
// per-(signature, account) counters with an optional magnitude, recorded at the
// sync/reconcile/mutation points where local state can diverge from the provider
// (ghost rows served, UIDVALIDITY resets, unread-count clamps, staleness-missed mail).
// Behavior-neutral observability; the report layer scopes to the user's accounts and
// hashes the id. Reset on process restart.
const syncSignals: Record<string, SyncSignal> = Object.create(null); // "sig|accountId" -> { sig, accountId, count, lastT, sumMag, maxMag }

export function recordSyncSignal(sig: string): void;
export function recordSyncSignal(sig: string, input: SyncSignalInput): void;
export function recordSyncSignal(sig: string, ...inputs: [] | [SyncSignalInput]): void {
  if (!sig) return;

  const input = inputs[0];
  const suppliedAccountId = input === undefined ? undefined : input.accountId;
  const accountId = typeof suppliedAccountId === 'string' ? suppliedAccountId : null;
  const suppliedMagnitude = input === undefined ? undefined : input.magnitude;
  const magnitude = typeof suppliedMagnitude === 'number' ? suppliedMagnitude : null;
  const key = `${sig}|${accountId || ''}`;
  const signal = syncSignals[key] ?? {
    sig,
    accountId: accountId || null,
    count: 0,
    lastT: 0,
    sumMag: 0,
    maxMag: 0,
  };

  signal.count += 1;
  signal.lastT = Date.now();
  if (magnitude !== null && Number.isFinite(magnitude)) {
    const absoluteMagnitude = Math.abs(magnitude);
    signal.sumMag += absoluteMagnitude;
    if (absoluteMagnitude > signal.maxMag) signal.maxMag = absoluteMagnitude;
  }
  syncSignals[key] = signal;
}

export function getSyncSignalsRaw(): SyncSignal[] {
  return Object.values(syncSignals).sort((left, right) => right.lastT - left.lastT);
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
export function getWarningsRaw(): WarningAggregate[] {
  const aggregates = new Map<string, WarningAggregate>();
  for (const warning of warnings) {
    const key = `${warning.code}|${warning.accountId || ''}`;
    const aggregate = aggregates.get(key) ?? {
      code: warning.code,
      accountId: warning.accountId,
      count: 0,
      lastT: 0,
    };
    aggregate.count += 1;
    aggregate.lastT = Math.max(aggregate.lastT, warning.t);
    aggregates.set(key, aggregate);
  }
  return [...aggregates.values()].sort((left, right) => right.lastT - left.lastT);
}

export function getConnectionStats(): {
  wsConnects: number;
  wsDisconnects: number;
  currentSockets: number;
  broadcastCounts: Record<string, number>;
} {
  return { wsConnects, wsDisconnects, currentSockets, broadcastCounts: { ...broadcastCounts } };
}

// Test-only reset.
export function _resetDiagnosticsRing(): void {
  warnings.length = 0;
  replyEvents.length = 0;
  for (const key of Object.keys(broadcastCounts)) delete broadcastCounts[key];
  for (const key of Object.keys(syncSignals)) delete syncSignals[key];
  wsConnects = 0;
  wsDisconnects = 0;
  currentSockets = 0;
}
