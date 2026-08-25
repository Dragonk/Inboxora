import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordWarning, recordBroadcast, recordWsConnect, recordWsDisconnect,
  getWarningsRaw, getConnectionStats, _resetDiagnosticsRing,
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
});
