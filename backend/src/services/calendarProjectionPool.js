// Bounded worker-thread pool for calendar recurrence projection.
//
// Recurrence expansion is synchronous CPU work. Running it on the API event loop
// delays every other request handled by that process (mail, contacts, auth),
// which is what makes the calendar feel like it "freezes" the rest of the app.
// This pool keeps that work on a small, fixed set of worker threads and gives it
// an explicit budget.
//
// Design constraints (all deliberate):
//  * One resource per job. A pathological series can only ever fail or time out
//    its own job; every other calendar in the request still projects normally.
//  * A worker handles one job at a time, so a hard timeout can terminate and
//    replace exactly that worker without destroying unrelated in-flight work.
//  * The pending queue is bounded. Overflow is reported, never silently dropped.
//  * Exceeding the budget surfaces as `truncated` plus a per-resource failure —
//    never as a quietly incomplete event list.
//  * If workers cannot be created the pool degrades to inline projection so a
//    calendar request still succeeds; the caller can see that it was degraded.

import { Worker } from 'node:worker_threads';
import os from 'node:os';

import { DEFAULT_MAX_ITERATIONS, projectCalendarResourceWithStatus } from '../utils/calendarRecurrence.js';

const WORKER_URL = new URL('./calendarProjectionWorker.js', import.meta.url);

function envInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function defaultWorkerCount() {
  const parallelism = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, parallelism - 1));
}

function config() {
  return {
    enabled: process.env.CALENDAR_PROJECTION_DISABLED !== '1',
    workers: envInt('CALENDAR_PROJECTION_WORKERS', defaultWorkerCount(), { min: 1, max: 16 }),
    timeoutMs: envInt('CALENDAR_PROJECTION_TIMEOUT_MS', 5000, { min: 100, max: 120000 }),
    maxQueue: envInt('CALENDAR_PROJECTION_MAX_QUEUE', 2000, { min: 1, max: 100000 }),
    maxIterations: envInt('CALENDAR_PROJECTION_MAX_ITERATIONS', DEFAULT_MAX_ITERATIONS, { min: 1 }),
    cacheEnabled: process.env.CALENDAR_PROJECTION_CACHE_DISABLED !== '1',
    cacheEntries: envInt('CALENDAR_PROJECTION_CACHE_ENTRIES', PROJECTION_CACHE_ENTRIES_DEFAULT, { min: 1, max: 100000 }),
    cacheMaxEvents: envInt('CALENDAR_PROJECTION_CACHE_MAX_EVENTS', PROJECTION_CACHE_MAX_EVENTS_DEFAULT, { min: 1 }),
    cacheTtlMs: envInt('CALENDAR_PROJECTION_CACHE_TTL_MS', PROJECTION_CACHE_TTL_MS_DEFAULT, { min: 1000, max: 86400000 }),
    failureCacheTtlMs: envInt('CALENDAR_PROJECTION_FAILURE_CACHE_TTL_MS', PROJECTION_FAILURE_CACHE_TTL_MS_DEFAULT, { min: 1000, max: 86400000 }),
  };
}

let slots = null;
let pending = [];
let nextJobId = 1;
let closing = false;

// Worker threads inherit the parent's process.execArgv. Flags that only make
// sense for `--eval`/`--print` input (notably --input-type) make a file-based
// worker fail at startup, which would otherwise turn every projection into a
// reported failure. Strip those so the pool works however the server was
// launched; the remaining flags (memory limits, etc.) are still inherited.
function workerExecArgv() {
  const inherited = process.execArgv || [];
  const filtered = [];
  for (let index = 0; index < inherited.length; index += 1) {
    const flag = inherited[index];
    if (flag === '--input-type') { index += 1; continue; }
    if (flag.startsWith('--input-type=')) continue;
    filtered.push(flag);
  }
  return filtered;
}

function spawnSlot(settings) {
  const worker = new Worker(WORKER_URL, { name: 'calendar-projection', execArgv: workerExecArgv() });
  const slot = { worker, job: null, timer: null };
  worker.unref?.();
  worker.on('message', (message) => {
    if (!slot.job || message?.jobId !== slot.job.jobId) return;
    settleJob(slot, job => job.resolve({
      id: message.id ?? job.row?.id ?? null,
      events: Array.isArray(message.events) ? message.events : [],
      truncated: Boolean(message.truncated),
      reason: message.reason || null,
      error: message.error || null,
    }));
    drain();
  });
  worker.on('error', (error) => {
    settleJob(slot, job => job.resolve({
      id: job.row?.id ?? null,
      events: [],
      truncated: true,
      reason: 'worker-error',
      error: error instanceof Error ? error.message : String(error),
    }));
    drain();
  });
  worker.on('exit', () => {
    // A worker that stops mid-job (crash, OOM, terminate) fails only its own job.
    settleJob(slot, job => job.resolve({
      id: job.row?.id ?? null,
      events: [],
      truncated: true,
      reason: 'worker-exit',
      error: 'The calendar projection worker stopped unexpectedly',
    }));
    if (slots) {
      const index = slots.indexOf(slot);
      if (index >= 0) slots.splice(index, 1);
      if (!closing && slots.length < settings.workers) {
        try { slots.push(spawnSlot(settings)); } catch { /* keep the remaining workers */ }
      }
    }
    drain();
  });
  return slot;
}

function ensureSlots(settings) {
  if (slots) return slots;
  const created = [];
  for (let index = 0; index < settings.workers; index += 1) {
    try {
      created.push(spawnSlot(settings));
    } catch {
      // Worker startup can fail (restricted sandbox, exhausted threads). The
      // caller falls back to inline projection rather than failing the request.
      break;
    }
  }
  if (!created.length) return null;
  slots = created;
  return slots;
}

function settleJob(slot, build) {
  const job = slot.job;
  if (!job || job.done) return false;
  job.done = true;
  slot.job = null;
  if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
  build(job);
  return true;
}

function drain() {
  if (!slots || closing) return;
  const settings = config();
  for (const slot of [...slots]) {
    if (slot.job) continue;
    const next = pending.shift();
    if (!next) return;
    startJob(slot, next, settings);
  }
}

function startJob(slot, job, settings) {
  slot.job = job;
  // The projection loop cannot be interrupted from outside, so the hard budget
  // terminates this worker. Only this job is lost, and it is reported as such.
  slot.timer = setTimeout(() => {
    slot.timer = null;
    settleJob(slot, current => current.resolve({
      id: current.row?.id ?? null,
      events: [],
      truncated: true,
      reason: 'timeout',
      error: `Calendar projection exceeded the ${settings.timeoutMs} ms budget`,
    }));
    slot.worker.terminate().catch(() => {});
  }, settings.timeoutMs);
  try {
    slot.worker.postMessage({
      jobId: job.jobId,
      row: job.row,
      from: job.from,
      to: job.to,
      maxIterations: settings.maxIterations,
      deadlineMs: settings.timeoutMs,
    });
  } catch (error) {
    settleJob(slot, current => current.resolve({
      id: current.row?.id ?? null,
      events: [],
      truncated: true,
      reason: 'post-failed',
      error: error instanceof Error ? error.message : String(error),
    }));
    queueMicrotask(() => drain());
  }
}

function inlineProject(rows, from, to, options) {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const events = [];
  const failures = [];
  const truncatedSeries = [];
  for (const row of rows) {
    try {
      const status = projectCalendarResourceWithStatus(row, from, to, { maxIterations });
      events.push(...status.events);
      if (status.truncated) {
        truncatedSeries.push(row.id);
        failures.push({ id: row.id, error: status.error || 'Calendar projection was truncated', reason: status.reason || 'truncated' });
      }
    } catch (error) {
      failures.push({ id: row.id, error: error instanceof Error ? error.message : String(error), reason: 'rule-error' });
    }
  }
  return {
    events,
    failures,
    truncated: truncatedSeries.length > 0,
    truncatedSeries,
    overloaded: false,
    degraded: true,
  };
}

// ── Projection cache ────────────────────────────────────────────────────────
//
// The SQL lookup that feeds a projection is cheap and indexed; expanding the
// recurrences is what costs seconds. Results are cached per resource, keyed by
// the resource's data version (`etag`) and the requested window, so an unchanged
// calendar never re-expands. Every mutation path in the application — GUI edits,
// CalDAV writes, and external-source sync — assigns a new `etag` (a fresh UUID
// or a content hash), which makes an etag-keyed entry self-invalidating: an edit,
// import, exception change or delete simply stops matching. Bump
// PROJECTION_VERSION whenever the projection semantics change.
const PROJECTION_VERSION = 1;
// The key already carries the resource's `etag`, so an edit stops matching immediately and
// the TTL is only a memory safety valve, not a freshness mechanism. It is therefore set well
// beyond a browsing session: at five minutes, a normal visit to the calendar after any pause
// was a cold cache and re-walked every series from its origin — tens of milliseconds each,
// all of it CPU the request waits on. Thirty minutes makes re-entering the month the user
// was just looking at free.
const PROJECTION_CACHE_TTL_MS_DEFAULT = 1800000;
// A series that ran out of iteration budget or timed out is not cached for the full TTL,
// because the answer may change once load drops — but it is cached briefly all the same.
// Leaving it uncached meant one pathological series (measured at over a second to expand)
// was re-walked on every request, which is worse than repeating the same honest
// "incomplete" notice a moment later.
const PROJECTION_FAILURE_CACHE_TTL_MS_DEFAULT = 30000;
const PROJECTION_CACHE_ENTRIES_DEFAULT = 500;
const PROJECTION_CACHE_MAX_EVENTS_DEFAULT = 50000;

const projectionCache = new Map();
const inflightProjections = new Map();
let projectionCacheEvents = 0;

function projectionKey(userId, row, fromMs, toMs, maxIterations) {
  return `${userId ?? ''}\u0000${row.id}\u0000${row.etag ?? ''}\u0000${fromMs}\u0000${toMs}\u0000${maxIterations}\u0000${PROJECTION_VERSION}`;
}

function dateMs(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.getTime();
}

function cacheGet(key) {
  const entry = projectionCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    projectionCache.delete(key);
    projectionCacheEvents -= entry.status.events.length;
    return null;
  }
  // Re-insert to keep the most recently used entries at the tail.
  projectionCache.delete(key);
  projectionCache.set(key, entry);
  return entry.status;
}

function evictProjectionCache(settings) {
  while (projectionCache.size > (settings.cacheEntries ?? PROJECTION_CACHE_ENTRIES_DEFAULT)
    || projectionCacheEvents > (settings.cacheMaxEvents ?? PROJECTION_CACHE_MAX_EVENTS_DEFAULT)) {
    const oldestKey = projectionCache.keys().next().value;
    if (oldestKey === undefined) break;
    const entry = projectionCache.get(oldestKey);
    projectionCache.delete(oldestKey);
    if (entry) projectionCacheEvents -= entry.status.events.length;
  }
}

function cacheSet(key, status, settings, ttlMs) {
  // Empty successful results are cached too: a COUNT series that already ended
  // is a legitimate answer, and re-walking it on every request is pure waste.
  const existing = projectionCache.get(key);
  if (existing) {
    projectionCacheEvents -= existing.status.events.length;
    projectionCache.delete(key);
  }
  const ttl = ttlMs ?? settings.cacheTtlMs ?? PROJECTION_CACHE_TTL_MS_DEFAULT;
  projectionCache.set(key, { status, expiresAt: Date.now() + ttl });
  projectionCacheEvents += status.events.length;
  evictProjectionCache(settings);
}

/** Drop cached projections. Used by tests and by an explicit admin reset. */
export function clearCalendarProjectionCache() {
  projectionCache.clear();
  projectionCacheEvents = 0;
}

/** Introspection for diagnostics and tests. */
export function calendarProjectionCacheStats() {
  return { entries: projectionCache.size, events: projectionCacheEvents };
}

async function dispatchProjection(rows, from, to, options, settings) {
  if (!rows.length) return { events: [], failures: [], truncated: false, truncatedSeries: [], overloaded: false, degraded: false };
  if (options.useWorkers === false || !settings.enabled) return inlineProject(rows, from, to, { ...options, maxIterations: settings.maxIterations });
  const active = ensureSlots(settings);
  if (!active) return inlineProject(rows, from, to, options);

  const accepted = [];
  const overflow = [];
  for (const row of rows) {
    if (pending.length + accepted.length >= settings.maxQueue) overflow.push(row);
    else accepted.push(row);
  }

  const jobs = accepted.map(row => new Promise((resolve) => {
    pending.push({ jobId: nextJobId++, row, from, to, resolve, done: false });
  }));
  drain();

  const settled = await Promise.all(jobs);
  const events = [];
  const failures = overflow.map(row => ({ id: row.id, error: 'Calendar projection queue is full', reason: 'overloaded' }));
  const truncatedSeries = [];
  for (const result of settled) {
    if (result.events?.length) events.push(...result.events);
    if (result.truncated || result.error) {
      if (result.id != null) truncatedSeries.push(result.id);
      failures.push({ id: result.id, error: result.error || 'Calendar projection was truncated', reason: result.reason || 'truncated' });
    }
  }
  return {
    events,
    failures,
    truncated: failures.length > 0,
    truncatedSeries,
    overloaded: overflow.length > 0,
    degraded: false,
  };
}

/**
 * Project many calendar resources into a window.
 *
 * Always resolves with a structured result; an individual resource failure is
 * reported in `failures` instead of rejecting the whole batch. Results for
 * unchanged resources are served from the projection cache, and identical
 * concurrent projections of the same resource share one computation.
 */
export async function projectCalendarResources(rows, from, to, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { events: [], failures: [], truncated: false, truncatedSeries: [], overloaded: false, degraded: false };
  const settings = config();
  if (options.maxIterations) settings.maxIterations = options.maxIterations;
  const cacheEnabled = settings.cacheEnabled && options.cache !== false;
  const userId = options.userId ?? null;
  const fromMs = dateMs(from);
  const toMs = dateMs(to);

  const statuses = new Map();
  const missing = [];
  const awaiting = [];
  if (cacheEnabled) {
    for (const row of list) {
      const key = projectionKey(userId, row, fromMs, toMs, settings.maxIterations);
      const cached = cacheGet(key);
      if (cached) { statuses.set(row.id, cached); continue; }
      const inflight = inflightProjections.get(key);
      if (inflight) { awaiting.push({ row, promise: inflight }); continue; }
      missing.push({ row, key });
    }
  } else {
    for (const row of list) missing.push({ row, key: null });
  }

  // Register in-flight markers before dispatching so a concurrent request with
  // the same (resource, version, window) waits for this result instead of
  // queueing a duplicate expansion.
  const deferred = new Map();
  for (const item of missing) {
    if (!item.key) continue;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    inflightProjections.set(item.key, promise);
    deferred.set(item.key, resolve);
  }

  // dispatchProjection resolves with a structured result and only rejects on a
  // programming error, in which case this call rejects too (never a cached
  // success). The finally block only releases the in-flight markers.
  let aggregate;
  try {
    aggregate = await dispatchProjection(missing.map(item => item.row), from, to, options, settings);
  } finally {
    for (const key of deferred.keys()) inflightProjections.delete(key);
  }

  if (cacheEnabled && missing.length) {
    const eventsByRow = new Map();
    for (const event of aggregate.events) {
      const rowId = event.series_id ?? event.id;
      if (!eventsByRow.has(rowId)) eventsByRow.set(rowId, []);
      eventsByRow.get(rowId).push(event);
    }
    const failuresByRow = new Map(aggregate.failures.map(failure => [failure.id, failure]));
    for (const item of missing) {
      const failure = failuresByRow.get(item.row.id);
      const status = failure
        ? { events: [], truncated: true, reason: failure.reason || 'truncated', error: failure.error || null }
        : { events: eventsByRow.get(item.row.id) || [], truncated: false, reason: null, error: null };
      statuses.set(item.row.id, status);
      // Failures are cached too, on a short TTL: a series that overran its budget was
      // otherwise re-walked on every request, so one bad series could make the whole
      // calendar slow indefinitely. The short expiry lets it recover on its own.
      if (item.key) {
        cacheSet(item.key, status, settings, failure ? (settings.failureCacheTtlMs ?? PROJECTION_FAILURE_CACHE_TTL_MS_DEFAULT) : undefined);
      }
      const resolve = item.key ? deferred.get(item.key) : null;
      if (resolve) resolve(status);
    }
  } else {
    const failuresByRow = new Map(aggregate.failures.map(failure => [failure.id, failure]));
    for (const item of missing) {
      const failure = failuresByRow.get(item.row.id);
      statuses.set(item.row.id, failure
        ? { events: [], truncated: true, reason: failure.reason || 'truncated', error: failure.error || null }
        : { events: aggregate.events.filter(event => (event.series_id ?? event.id) === item.row.id), truncated: false, reason: null, error: null });
      const resolve = item.key ? deferred.get(item.key) : null;
      if (resolve) resolve(statuses.get(item.row.id));
    }
  }

  for (const item of awaiting) {
    try { statuses.set(item.row.id, await item.promise); } catch { /* fall through to no result for this row */ }
  }

  const events = [];
  const failures = [];
  const truncatedSeries = [];
  for (const row of list) {
    const status = statuses.get(row.id);
    if (!status) continue;
    if (status.events?.length) events.push(...status.events);
    if (status.truncated) {
      truncatedSeries.push(row.id);
      failures.push({ id: row.id, reason: status.reason, error: status.error });
    }
  }
  return {
    events,
    failures,
    truncated: failures.length > 0,
    truncatedSeries,
    overloaded: aggregate.overloaded,
    degraded: aggregate.degraded,
  };
}

/** Stop every worker. Intended for tests and graceful shutdown. */
export async function closeCalendarProjectionPool() {
  closing = true;
  const current = slots;
  slots = null;
  pending = [];
  if (current) {
    await Promise.allSettled(current.map(slot => {
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
      return slot.worker.terminate();
    }));
  }
  closing = false;
}

/** Introspection for diagnostics and tests. */
export function calendarProjectionPoolStats() {
  const settings = config();
  return {
    enabled: settings.enabled,
    workers: slots ? slots.length : 0,
    configuredWorkers: settings.workers,
    queued: pending.length,
    maxQueue: settings.maxQueue,
    timeoutMs: settings.timeoutMs,
    maxIterations: settings.maxIterations,
    cacheEnabled: settings.cacheEnabled,
    ...calendarProjectionCacheStats(),
  };
}
