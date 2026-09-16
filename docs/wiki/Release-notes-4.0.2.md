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
- An ambiguous invitation SMTP result or a post-SMTP database failure is now recorded as uncertain and excluded from automatic retry. Explicit SMTP 4xx/5xx rejections retain normal retry behavior. Transport preparation now completes before the durable uncertain marker: missing credentials, TLS-policy failures, DNS failures and MIME preparation errors can be retried because no SMTP dispatch started.
- Repeating an invitation request with the same idempotency key now returns its stored `uncertain` result and reconciliation warning rather than incorrectly presenting the operation as active processing. Invitation cancellation now returns its own durable `sent`, `failed`, `processing` or `uncertain` status, and a retry rechecks the same cancellation operation without mutating the event or creating another SMTP action. Rows with an ambiguous SMTP result remain excluded from automatic retry.
- Draft save acknowledgements now preserve newer To, CC and BCC edits, including removals and Enter/blur commits. A save-and-close request closes only when its exact snapshot remains current; later edits stay open and dirty for the next save. Reopened drafts retain their BCC recipients, selected alias, reply headers, editable body format, signature and historical UIDVALIDITY identity; an unavailable alias is rejected rather than silently using the primary address for either save or send. Each reopened draft keeps its saved text/HTML format regardless of later profile-preference changes through delivery MIME generation, including HTML-only quotes and inline images. Legacy API clients that omit the format flag retain literal text interpretation. Any restored signature remains visible and editable in both mobile and desktop layouts, and newly entered plaintext signatures are sent literally. Retries persisted with the immediately preceding idempotency fingerprint schema remain safely replayable after upgrade. A late draft-body response from an earlier authenticated session is discarded rather than opening private content in a later session. Replacing a draft after changing its sender account now retains the old draft's account and folder identity, so a matching UID in the newly selected account is never deleted.
- Deploy database migrations `0085_calendar_invitation_outbox_claim.sql` through `0093_draft_composition_metadata.sql` in sequence before running the updated workers or mail-send route. Migrations `0090_calendar_cancellation_outbox_reference.sql`, `0091_draft_uidvalidity_identity.sql`, `0092_draft_bcc_addresses.sql` and `0093_draft_composition_metadata.sql` must be applied before rollout: they bind a cancellation to its event, record the historical IMAP UIDVALIDITY required before destructive draft cleanup, retain BCC recipients, and preserve editable draft composition and reply metadata. Existing drafts without a recorded epoch are retained safely rather than deleted. Do not bulk-reset existing `uncertain` rows, because an earlier SMTP attempt may have been accepted.
- Chat-completions SSE treats an upstream EOF without a documented terminal event as an incomplete response. The proxy no longer appends a synthetic success marker to a truncated answer.

## Integration configuration

- Microsoft integration settings now apply as an exact saved configuration at runtime. Fields removed from a saved configuration are cleared immediately as well as after restart, avoiding stale credentials or tenant settings remaining in process state.

## Verification

Focused backend regression suites cover IMAP setup cleanup, AI streaming completion, Microsoft configuration reload behavior, delivery-result preservation and calendar-worker lifecycle transitions. Backend and frontend TypeScript checks pass.

See [`docs/CHANGELOG.md`](../CHANGELOG.md) for the concise release record.
