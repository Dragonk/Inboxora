import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordHttp, recordDb, getPerformanceSnapshot, _resetPerformanceMetrics,
} from './performanceMetrics.js';

describe('performanceMetrics', () => {
  beforeEach(() => _resetPerformanceMetrics());

  it('aggregates HTTP latency per route with mean/percentiles/errors', () => {
    for (let i = 0; i < 100; i += 1) recordHttp('GET /api/mail/messages', 40); // all in the <=50 bucket
    recordHttp('GET /api/mail/messages', 4000, true); // one slow error
    const snap = getPerformanceSnapshot();
    const row = snap.http.slowest.find(r => r.route === 'GET /api/mail/messages');
    expect(row.count).toBe(101);
    expect(row.errors).toBe(1);
    expect(row.maxMs).toBe(4000);
    expect(row.p50Ms).toBe(50);   // median sits in the <=50 bucket
    expect(row.meanMs).toBeGreaterThan(40);
  });

  it('ranks the slowest route first by p95', () => {
    recordHttp('GET /fast', 5);
    recordHttp('GET /fast', 5);
    recordHttp('GET /slow', 3000);
    recordHttp('GET /slow', 3000);
    const snap = getPerformanceSnapshot();
    expect(snap.http.slowest[0].route).toBe('GET /slow');
    expect(snap.http.routeCount).toBe(2);
  });

  it('summarizes DB latency and counts slow queries over the threshold', () => {
    recordDb(5);
    recordDb(15);
    recordDb(300); // slow (>= 200ms)
    const snap = getPerformanceSnapshot();
    expect(snap.db.count).toBe(3);
    expect(snap.db.slowCount).toBe(1);
    expect(snap.db.slowThresholdMs).toBe(200);
    expect(snap.db.maxMs).toBe(300);
  });

  it('ignores non-finite values and resets cleanly', () => {
    recordHttp('GET /x', NaN);
    recordDb(Infinity);
    expect(getPerformanceSnapshot().http.routeCount).toBe(0);
    expect(getPerformanceSnapshot().db.count).toBe(0);
    recordHttp('GET /x', 10);
    _resetPerformanceMetrics();
    const snap = getPerformanceSnapshot();
    expect(snap.http.routeCount).toBe(0);
    expect(snap.db.count).toBe(0);
  });
});
