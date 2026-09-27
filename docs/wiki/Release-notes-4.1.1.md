# Release notes 4.1.1

**Status:** Hotfix  ·  **Release date:** 2026-09-25  ·  **Previous version:** 4.1.0

## Desktop overlay sizing follow-up

Installed desktop PWAs update the drag strip and scaled mail content when the window-controls-overlay height changes, even if the overlay stays visible and the window size does not change. No migration or configuration change is required. Browser regression coverage checks both cases.

## Fixed
- **Legacy CardDAV, CalDAV and ICS sources can be removed again.** Older installations can retain local DAV or calendar-subscription projections after their original connection metadata is no longer available. These orphaned entries now expose a local removal action in Contacts and Calendar settings. Cleanup is scoped to the authenticated user, never contacts or deletes data from the remote server, and refuses current CardDAV integrations, current CalDAV/ICS sources, Google/Microsoft provider calendars and local Inboxora calendars. Existing source disconnect behaviour is unchanged, and no database migration is required. CardDAV cleanup preserves books owned directly or through collection links by a current integration, and removes orphaned books and their legacy connection in one transaction. Legacy connection metadata is retained while a preserved book still directly references it, preventing cascading deletion. No configuration change is required. PostgreSQL route regressions cover ownership protection, isolation and rollback; frontend behavioral tests cover cleanup eligibility and API selection.
- **Graph bulk move results expose per-message failures.** If a provider move is not projected locally, the response identifies that message in `failed` and sets `ok` to false; confirmed moves still appear in `moved`. No migration or configuration change is required. Route regression tests cover failed, successful and mixed results.
- **Microsoft Graph rebuilt baselines no longer delete mail by omission.** Inboxora now removes a provider-backed message only when Graph delta explicitly reports an `@removed` event. Rebuilding an expired or reset delta cursor can no longer make a newly delivered or otherwise valid message disappear from the local mailbox.

- **Microsoft Graph push starts for existing mailboxes.** When provider push is enabled after an account was already connected, Inboxora now bootstraps the missing mail subscription automatically; the two-minute polling path remains the reliability fallback.
- **Microsoft Graph attachments load correctly.** Inboxora no longer requests `contentId` through an invalid base-attachment `$select`, so attachment metadata and inline CID images can be read without the Graph OData error.
- **Threaded mail list visibility.** Messages with empty `thread_key` now use `thread_id`, then a unique physical-message identity. Independent messages are no longer grouped into one nullable bucket or omitted. Pagination, totals, deduplication and thread expansion share the same identity rules.
- **Microsoft Graph immutable message IDs.** Body, headers, attachment metadata, inline images, single downloads, ZIP downloads and mail mutations consistently use `Prefer: IdType="ImmutableId"` whenever the connection has immutable IDs enabled.
- **Microsoft Graph historical mail delta sync after reconnect.** Delta sync requests now specify page sizes via `Prefer: odata.maxpagesize=200` rather than `$top` on `/messages/delta`, keeping opaque continuation links intact across full traversals. Reconnecting a previously revoked or inactive Microsoft connection clears mail delta cursors and checkpoints to guarantee a clean baseline import, while preserving state during routine token/consent refreshes on active connections.

## User and operator impact

- **New users and initial mailbox sync:** New Microsoft integrations traverse historical folder items completely using `Prefer: odata.maxpagesize=200` without hitting the premature delta round termination previously caused by `$top`.
- **Upgrading from 4.1.0:** Active connections continue synchronizing incrementally without losing state. If an existing Microsoft mailbox missed historical items during an earlier import, disconnecting and reconnecting the account now resets the mail delta state and triggers a full baseline import. Unthreaded messages without `thread_key` are immediately visible in threaded folder views.

## Validation and upgrade

The upgrade includes `0141_message_list_hot_path_indexes.sql` for the message-list hot path, `0142_graph_pending_message_removals.sql` for durable Microsoft Graph tombstone reconciliation, and `0143_repair_message_list_hot_path_index.sql` as the forward repair for installations that already recorded the first 0141 revision, `0144_normalize_message_ids.sql` to normalize historical RFC Message-ID values, and `0145_graph_consistency.sql` for Unicode-consistent normalization, snooze-reference repair and confirmed Graph moves.


Apply the complete migration chain through `0145_graph_consistency.sql` before rolling out 4.1.1. The normal backend startup migration runner applies pending migrations automatically. The release includes a real PostgreSQL regression for three independent messages with null thread identifiers, reconnect cursor reset, and Graph regression coverage for immutable-ID reads, mutations, and delta pagination.

Before publishing, validate on the `dev` deployment that threaded and flat views, refreshes and folder changes retain messages, and that old and new Microsoft messages open their bodies and support regular, inline-CID, single and ZIP attachment downloads. Do not publish if any of these live checks fail.


## Additional Graph consistency repair

Apply migrations in order through `0145_graph_consistency.sql` before this backend starts.
This forward migration leaves 0141–0144 unchanged, normalizes the same whitespace as
JavaScript ingestion, repairs matching snooze references and adds confirmed-MOVE receipts.
Read/unread deltas preserve omitted metadata. Only inserted arrivals enter ingest rules.
A hydrated item with empty display metadata no longer blocks a delta page; provider identity and folder validation remain mandatory.
Moves update one canonical row and do not identify physical copies by RFC Message-ID.
Cleanup verifies an explicit per-item Graph ID conversion and the current stable location;
failed conversions, unavailable services and unknown folder mappings remain visible/retryable.
This is not a blanket ban on real deletions and is not a bulk identity migration.

Release gate: run the PostgreSQL tests (not skipped), then read, spam/ham, round-trip move,
provider-side delete, delayed replay and two physical copies with the same Message-ID on
an actual mailbox. Track UUIDs as well as subjects. Do not release based on a mock-only run.

## Live mail refresh and unread indicators (PR14)

Graph/Gmail background commits now publish user-scoped mailbox invalidations. The browser refreshes the current list and unread counts without F5, including message-state and folder-membership changes. UI invalidation is independent of alerts, notification permission and historical import notifications.

Visible clients reconcile local API data within roughly 60 seconds plus API latency if an event is lost, even while WebSocket ping/pong remains healthy. Returning from sleep, offline mode or bfcache revalidates the view. Refresh bursts are serialized; current selection, reader and account/folder scope remain intact. This is not additional polling of Microsoft/Google.

The tab title shows `(N) Inboxora` when unread indicators are enabled. Supported installed PWAs use one service-worker badge writer with current authenticated unread counts; unavailable/denied Badging API support does not block the message list. The existing favicon/branding remains unchanged. The unified unread total excludes opted-out accounts, archived/deleted/placeholder rows and includes Gmail INBOX membership without double-counting labels.

No new database migration or service is introduced. The existing migration endpoint remains `0145_graph_consistency.sql`. PR13's legacy DAV/ICS cleanup and the existing Graph identity/removal protections remain unchanged.

Validation before release: execute the new PostgreSQL/WebSocket regressions (not skipped), the full backend/frontend suites and the live-browser test. Then verify Graph, Gmail and IMAP with a continuously open tab, disabled notifications, read/unread on another device, lost WS events, search/threaded views, and an installed PWA's actual OS badge. Build success alone does not establish live-mailbox correctness.

## Unreleased follow-up: IMAP storage growth and serialization (#16)

This follow-up is not part of the already-published 4.1.1 image. Use a build containing this
change (or its subsequent release) before running the maintenance commands below. It does
not change the release number or any previously applied migration. The existing migration
chain through `0145_graph_consistency.sql` remains the prerequisite; there is no new migration.

### Cause and behavior

The report concerns **disk usage**, particularly PostgreSQL TOAST and container logs, not
process RAM. ImapFlow exposes fetched `headers` as a `Buffer`. The conversation envelope
serializer treated its `entries()` as a header map, storing `0: 82`, `1: 101`, etc. instead of
RFC header text. A 6,819-byte synthetic header became 71,834 bytes (10.53×) before database
compression. This is a confirmed defect, not intended caching overhead. These figures are
logical payload bytes, **not** a measurement of the reporter's database or a promise of the
same filesystem reduction. Migration `0139` stopped the second copy on `logical_messages`,
but left this independent expansion on `messages`, explaining why a clean installation
could grow again.

The fix decodes binary headers directly, retaining folding, repeated fields and Unicode.
It also moves the header update and identity lookup inside the same per-account,
SERIALIZABLE transaction as conversation projection. The old standalone update could run
while another projection/rebuild held that lock, and remained committed if projection
failed. Unchanged headers are no longer rewritten. Account joins lock the message, not the
unrelated account row; disabled automated-series matching avoids loading unused candidates.
Existing attached messages without an RFC Message-ID retain their logical-message and
conversation identity after a header/body cache change. Authentication, account boundaries,
manual threading state, transaction isolation and retry handling remain enforced.

Occasional serialization retries can still occur with other concurrent writers; this is
not a claim that every `40001` is a defect or can be eliminated. Do not suppress PostgreSQL
errors or reduce isolation to hide a failure. Both standard Compose files now bound
stdout/stderr JSON logs to three 10 MiB files per service. This is a per-container log bound,
not a cap on PostgreSQL tables, indexes, WAL, Redis persistence, images or custom log files.
An overridden logging collector should keep its own appropriate retention policy.

Inboxora intentionally stores message metadata, conversation data and physical-copy headers
locally. Body caching/prefetch depends on the provider and access path. This fix does not turn
it into a metadata-only client, promise that any mailbox fits in a 3 GB LXC, or copy every
attachment into PostgreSQL. Assess actual mailbox size and Docker/database overhead separately.

### Existing installations: diagnose before writing

After installing the fixed backend, updating Compose, and **recreating** affected containers
to apply logging options, inspect the report without modifying data:

```sh
docker compose exec -T backend node dist/scripts/repairConversationHeaders.js
```

Use the same Compose `-f` options/project name as the installation. The default command is
read-only and prints only counts/byte totals, not mail content, addresses or credentials.
`repairable`, `beforeBytes`, `afterBytes` and `logicalBytesSaved` describe valid legacy payloads
before TOAST compression. `skipped` counts malformed, non-UTF-8 or unusually large candidates
left untouched. All local accounts are visited using owner/account-scoped queries. Each batch
has at most 50 rows and payloads are fetched individually; values over 16 MiB are skipped.

Read-only PostgreSQL checks (run through an authorized SQL client) separate live data from
other disk consumers without printing mail content:

```sql
SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size;
SELECT relname,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_with_indexes_toast,
       pg_size_pretty(pg_table_size(relid)) AS table_with_toast,
       pg_size_pretty(pg_indexes_size(relid)) AS indexes,
       n_live_tup, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 15;
SELECT count(*) AS messages,
       count(*) FILTER (WHERE conversation_raw_headers LIKE '0: %') AS legacy_candidates,
       sum(octet_length(conversation_raw_headers)) AS logical_header_bytes
FROM messages;
```

The aggregate header check scans the table; use it during a quiet period on a large mailbox.
Also inspect filesystem usage and `docker system df -v` to distinguish database volumes,
container writable layers and images. `docker inspect` can show each container's `LogPath`
and `HostConfig.LogConfig`. Inspect file sizes with host tools, **not** manual edits/truncation
of Docker-managed log files. Use PostgreSQL/admin filesystem diagnostics separately for WAL
and custom log destinations; relation sizes alone do not account for the entire LXC.

### Optional repair

Back up the database and ensure free working space first: even a shrinking UPDATE generates
WAL and old row versions. Do not run a repair on a completely full filesystem or alongside
old backend workers that can reintroduce the byte expansion. With the fixed build deployed:

```sh
docker compose exec -T backend node dist/scripts/repairConversationHeaders.js --apply
```

The command decodes only validated, sequential byte lists, updates physical header payloads
under the shared account lock, commits bounded batches and can be rerun after interruption.
It does not delete messages, clear bodies, alter provider cursors, discard logical identities
or rebuild user conversations. A failing batch rolls back in full; earlier committed batches
remain repaired. Ambiguous/oversized values are reported and left intact rather than guessed
or truncated. There is deliberately no automatic startup rewrite of a potentially full DB.

Ordinary autovacuum/VACUUM makes dead space reusable; it generally does **not** shrink the
files immediately. `VACUUM FULL` requires an exclusive table lock and additional disk space,
so it is not run by this command and is not an automatic recommendation for a full LXC.
Plan any physical compaction separately with a backup and a maintenance window. Do not delete
or recreate the database as the default recovery procedure.

### Regression coverage and limits

Coverage includes binary header/view boundaries, exact folding/Unicode, real PostgreSQL
lock ordering and rollback, concurrent ingestion, no-op updates, tenant rejection, bounded
repair/dry-run/idempotence, unchanged message/conversation IDs after rebuild, malformed and
oversized values, and repair-batch rollback. The PostgreSQL workflow explicitly executes
the storage regressions; the push-stack workflow resolves **both** Compose files, including
the optional HTTPS service, and checks every service's log configuration.

The reporter's exact table/TOAST/WAL/log breakdown still needs confirmation after deployment.
Do not equate a reproduced defect with proof that it explains every byte in their LXC.

References: [Docker JSON log rotation](https://docs.docker.com/engine/logging/drivers/json-file/),
[PostgreSQL vacuum/space reuse](https://www.postgresql.org/docs/16/routine-vacuuming.html),
[PostgreSQL transaction isolation](https://www.postgresql.org/docs/16/transaction-iso.html).
