// Worker-thread entry for calendar recurrence projection.
//
// One message carries one calendar resource. Running each resource in its own
// job keeps a single pathological series (an enormous rule, a damaged document,
// an unbounded iterator) from delaying or discarding every other calendar in the
// same request. The worker only ever receives data and posts plain structured
// results back; it never touches the database, the session or the network.

import { parentPort } from 'node:worker_threads';

import { projectCalendarResourceWithStatus } from '../utils/calendarRecurrence.js';

function failureResult(row, error) {
  return {
    ok: false,
    id: row?.id ?? null,
    error: error instanceof Error ? error.message : String(error),
    events: [],
    truncated: true,
    reason: 'rule-error',
  };
}

parentPort.on('message', (message) => {
  const { jobId, row, from, to, maxIterations, deadlineMs } = message || {};
  let response;
  try {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      response = failureResult(row, new Error('Invalid projection range'));
    } else {
      const deadline = Number.isFinite(deadlineMs) && deadlineMs > 0 ? Date.now() + deadlineMs : null;
      const status = projectCalendarResourceWithStatus(row, fromDate, toDate, { maxIterations, deadline });
      response = {
        ok: true,
        id: row?.id ?? null,
        events: status.events,
        truncated: Boolean(status.truncated),
        reason: status.reason || null,
        error: status.error || null,
      };
    }
  } catch (error) {
    // projectCalendarResourceWithStatus already contains per-resource failures,
    // so reaching here means something outside the projection failed. Report it
    // instead of letting the worker die with an unhandled rejection.
    response = failureResult(row, error);
  }
  parentPort.postMessage({ jobId, ...response });
});
