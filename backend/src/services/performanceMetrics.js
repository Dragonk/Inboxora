// In-memory performance baseline metrics (measure-first, behavior-neutral).
//
// Aggregates HTTP request latency per route pattern and DB query latency into
// bounded bucket histograms, so the diagnostics report can show mean/p50/p95/max
// without storing per-event data or anything identifying. Route keys are the
// matched Express *pattern* (e.g. "GET /api/mail/messages/:id"), never a concrete
// URL, so no ids or PII enter here and cardinality stays bounded. Reset on restart.

const LATENCY_EDGES_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000]; // bucket upper edges
const DB_SLOW_MS = 200;

function newHisto() {
  return { count: 0, sumMs: 0, maxMs: 0, buckets: new Array(LATENCY_EDGES_MS.length + 1).fill(0) };
}

function record(h, ms) {
  h.count += 1;
  h.sumMs += ms;
  if (ms > h.maxMs) h.maxMs = ms;
  let i = 0;
  while (i < LATENCY_EDGES_MS.length && ms > LATENCY_EDGES_MS[i]) i += 1;
  h.buckets[i] += 1;
}

// Percentile estimated from the histogram: returns the bucket's upper edge (an
// upper bound on the true value), or the observed max for the overflow bucket.
function percentile(h, p) {
  if (!h.count) return 0;
  const target = Math.ceil((p / 100) * h.count);
  let cum = 0;
  for (let i = 0; i < h.buckets.length; i += 1) {
    cum += h.buckets[i];
    if (cum >= target) {
      return i < LATENCY_EDGES_MS.length ? LATENCY_EDGES_MS[i] : Math.round(h.maxMs);
    }
  }
  return Math.round(h.maxMs);
}

const httpRoutes = Object.create(null); // routeKey -> { h, errors }
const db = newHisto();
let dbSlow = 0;

export function recordHttp(routeKey, ms, isError = false) {
  if (!routeKey || !Number.isFinite(ms)) return;
  const e = httpRoutes[routeKey] || (httpRoutes[routeKey] = { h: newHisto(), errors: 0 });
  record(e.h, ms);
  if (isError) e.errors += 1;
}

export function recordDb(ms) {
  if (!Number.isFinite(ms)) return;
  record(db, ms);
  if (ms >= DB_SLOW_MS) dbSlow += 1;
}

function summarize(h) {
  return {
    count: h.count,
    meanMs: h.count ? Math.round(h.sumMs / h.count) : 0,
    p50Ms: percentile(h, 50),
    p95Ms: percentile(h, 95),
    maxMs: Math.round(h.maxMs),
  };
}

// Snapshot for the diagnostics report: the slowest routes (by p95, then volume) and
// the DB summary. All numbers, no PII.
export function getPerformanceSnapshot({ topN = 12 } = {}) {
  const routes = Object.entries(httpRoutes).map(([route, e]) => ({
    route, errors: e.errors, ...summarize(e.h),
  }));
  routes.sort((a, b) => (b.p95Ms - a.p95Ms) || (b.count - a.count));
  return {
    http: { routeCount: routes.length, slowest: routes.slice(0, topN) },
    db: { ...summarize(db), slowCount: dbSlow, slowThresholdMs: DB_SLOW_MS },
  };
}

export function _resetPerformanceMetrics() {
  for (const k of Object.keys(httpRoutes)) delete httpRoutes[k];
  db.count = 0; db.sumMs = 0; db.maxMs = 0; db.buckets.fill(0);
  dbSlow = 0;
}
