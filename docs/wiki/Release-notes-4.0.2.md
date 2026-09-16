# Release notes 4.0.2

**Status:** released 2026-09-15 · **Previous version:** 4.0.1 · **Type:** patch

## What this release fixes

4.0.2 is a reliability and data-isolation patch. It fixes confirmed failure paths in sending, session changes, IMAP, calendar processing, AI streaming and Microsoft integration configuration. It adds no user-facing feature. Apply the included calendar-invitation outbox migration before deploying workers; no configuration change is required.

## Mail delivery and sessions

- Partial SMTP acceptance is preserved even when later Sent-folder processing fails. The composer no longer presents a partial recipient failure as an ordinary full success: it keeps the draft open and prepares a retry only for recipients the server rejected.
- A failed idempotency-lease renewal is now treated as an uncertain in-flight operation in the serving process, preventing an automatic duplicate send after Redis recovers. SMTP cannot provide exactly-once delivery, so an uncertain operation is not retried automatically. Durable send intents now carry a canonical request fingerprint, so a changed request cannot reuse a completed key; ambiguous post-dispatch transport loss remains uncertain instead of being automatically retried.
- Partial-send retries retain the original To, CC and BCC roles, including BCC-only delivery without a visible To header. Delayed compose and API-auth callbacks are tied to their originating session, so an earlier session cannot close or alter a new editor.
- Auth-session generations prevent late account and deep-link responses from an earlier SPA session from writing into a later user's state. Persisted account/folder navigation is associated with its owner, so a normal reload restores the right location without leaking another user's selection.
- IMAP connection-in-progress markers are released for every setup failure, including host-resolution failures, so reconnect remains possible after a transient DNS problem.

## Calendar and AI reliability

- A calendar projection worker is retired before the queue drains after an error, timeout or termination. A healthy queued task is therefore handed to a live replacement worker rather than a worker that is exiting.
- Calendar invitation outbox rows are atomically claimed with an owner token and expiry. A partial SMTP rejection remains queued only for rejected attendees, and overlapping timer/manual drains cannot both deliver the same claim. Accepted actions are checkpointed so later failures do not resend them; final completion is atomic and recovery recognises its explicit marker. All invitation requests, including requests without a client idempotency header, use the durable outbox flow.
- Deletion cancellations keep their retry payload after the event is removed, and a missing sender remains a visible failed delivery rather than being silently discarded. Edits or cancellations of invited recurring occurrences fail closed with `409` rather than issuing an incomplete attendee notification.
- An ambiguous invitation SMTP result or a post-SMTP database failure is now recorded as uncertain and excluded from automatic retry. Explicit SMTP 4xx/5xx rejections retain normal retry behavior. Draft autosave snapshots its request input, so edits typed during an in-flight save remain pending.
- Deploy database migrations `0085_calendar_invitation_outbox_claim.sql` through `0089_calendar_invitation_outbox_uncertain_dispatch.sql` in sequence before running the updated workers or mail-send route.
- Chat-completions SSE treats an upstream EOF without a documented terminal event as an incomplete response. The proxy no longer appends a synthetic success marker to a truncated answer.

## Integration configuration

- Microsoft integration settings now apply as an exact saved configuration at runtime. Fields removed from a saved configuration are cleared immediately as well as after restart, avoiding stale credentials or tenant settings remaining in process state.

## Verification

Focused backend regression suites cover IMAP setup cleanup, AI streaming completion, Microsoft configuration reload behavior, delivery-result preservation and calendar-worker lifecycle transitions. Backend and frontend TypeScript checks pass.

See [`docs/CHANGELOG.md`](../CHANGELOG.md) for the concise release record.
