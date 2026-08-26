import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordWarning, recordBroadcast, recordWsConnect, recordWsDisconnect,
  getWarningsRaw, getConnectionStats, recordSyncSignal, getSyncSignalsRaw,
  _resetDiagnosticsRing,
} from './diagnosticsRing.js';

describe('diagnosticsRing', () => {
  beforeEach(() => _resetDiagnosticsRing());

  it('aggregates warnings by code+account with count and last-seen', () => {
    recordWarning('imap_error', 'a1');
    recordWarning('imap_error', 'a1');
    recordWarning('staleness_error', null);
    const raw = getWarningsRaw();
    const imap = raw.find(w => w.code === 'imap_error');
    expect(imap.accountId).toBe('a1');
    expect(imap.count).toBe(2);
    expect(raw.some(w => w.code === 'staleness_error' && !w.accountId)).toBe(true);
  });

  it('counts broadcasts by type and tracks ws connect/disconnect', () => {
    recordBroadcast('new_messages');
    recordBroadcast('new_messages');
    recordBroadcast('folders_synced');
    recordWsConnect();
    recordWsConnect();
    recordWsDisconnect();
    const c = getConnectionStats();
    expect(c.broadcastCounts.new_messages).toBe(2);
    expect(c.broadcastCounts.folders_synced).toBe(1);
    expect(c.wsConnects).toBe(2);
    expect(c.wsDisconnects).toBe(1);
    expect(c.currentSockets).toBe(1);
  });

  it('ignores empty codes/types and never drops sockets below zero', () => {
    recordWarning('');
    recordBroadcast(null);
    recordWsDisconnect();
    expect(getWarningsRaw()).toHaveLength(0);
    expect(getConnectionStats().currentSockets).toBe(0);
  });

  it('aggregates sync signals by signature+account with count and magnitude', () => {
    recordSyncSignal('ghost_rows_served', { accountId: 'a1', magnitude: 3 });
    recordSyncSignal('ghost_rows_served', { accountId: 'a1', magnitude: 2 });
    recordSyncSignal('uidvalidity_change', { accountId: 'a2' });
    recordSyncSignal('badge_count_clamp', {}); // account-less
    const raw = getSyncSignalsRaw();
    const ghost = raw.find(s => s.sig === 'ghost_rows_served');
    expect(ghost.accountId).toBe('a1');
    expect(ghost.count).toBe(2);
    expect(ghost.sumMag).toBe(5);
    expect(ghost.maxMag).toBe(3);
    const uv = raw.find(s => s.sig === 'uidvalidity_change');
    expect(uv.count).toBe(1);
    expect(uv.sumMag).toBe(0); // no magnitude recorded
    expect(raw.some(s => s.sig === 'badge_count_clamp' && !s.accountId)).toBe(true);
  });

  it('ignores empty sync signatures and resets with the ring', () => {
    recordSyncSignal('');
    expect(getSyncSignalsRaw()).toHaveLength(0);
    recordSyncSignal('uidvalidity_change', { accountId: 'a1' });
    _resetDiagnosticsRing();
    expect(getSyncSignalsRaw()).toHaveLength(0);
  });
});
