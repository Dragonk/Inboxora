# Release notes 4.0.2

**Status:** released 2026-09-15 · **Previous version:** 4.0.1 · **Type:** patch

## What this release fixes

4.0.2 is a reliability and data-isolation patch. It fixes confirmed failure paths in sending, session changes, IMAP, calendar processing, AI streaming and Microsoft integration configuration. It adds no user-facing feature. Apply the included calendar-invitation outbox migration before deploying workers; no configuration change is required.

## Mail delivery and sessions

- Partial SMTP acceptance is preserved even when later Sent-folder processing fails. The composer no longer presents a partial recipient failure as an ordinary full success: it keeps the draft open and prepares a retry only for recipients the server rejected.
- A failed idempotency-lease renewal is now treated as an uncertain in-flight operation in the serving process, preventing an automatic duplicate send after Redis recovers. SMTP cannot provide exactly-once delivery, so an uncertain operation is not retried automatically.
- Auth-session generations prevent late account and deep-link responses from an earlier SPA session from writing into a later user's state. Persisted account/folder navigation is associated with its owner, so a normal reload restores the right location without leaking another user's selection.
- IMAP connection-in-progress markers are released for every setup failure, including host-resolution failures, so reconnect remains possible after a transient DNS problem.

## Calendar and AI reliability

- A calendar projection worker is retired before the queue drains after an error, timeout or termination. A healthy queued task is therefore handed to a live replacement worker rather than a worker that is exiting.
- Calendar invitation outbox rows are atomically claimed with an owner token and expiry. A partial SMTP rejection remains queued only for rejected attendees, and overlapping timer/manual drains cannot both deliver the same claim. Deploy migration `0085_calendar_invitation_outbox_claim.sql` with this change.
- Chat-completions SSE treats an upstream EOF without a documented terminal event as an incomplete response. The proxy no longer appends a synthetic success marker to a truncated answer.

## Integration configuration

- Microsoft integration settings now apply as an exact saved configuration at runtime. Fields removed from a saved configuration are cleared immediately as well as after restart, avoiding stale credentials or tenant settings remaining in process state.

## Verification

Focused backend regression suites cover IMAP setup cleanup, AI streaming completion, Microsoft configuration reload behavior, delivery-result preservation and calendar-worker lifecycle transitions. Backend and frontend TypeScript checks pass.

See [`docs/CHANGELOG.md`](../CHANGELOG.md) for the concise release record.
