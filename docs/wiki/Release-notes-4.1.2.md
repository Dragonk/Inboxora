# Release notes 4.1.2 — draft

**Status: unreleased; dev verification only.** No version tag, package version bump or
production deployment is part of this change. Release only after the maintainer's
existing database test and the original #16 reporter's confirmation.

## Storage repair and bounded synchronization

Two independent growth defects are addressed. IMAP binary headers were converted into
numbered byte entries, expanding their logical representation roughly tenfold. Calendar
and CardDAV sync journals stored another complete iCalendar/vCard for every update,
including unchanged synchronization results, and never retired old history.

Migration `0146_bounded_dav_sync_storage.sql` retires the two historical journal tables
under versioned names and creates compact journals. Each DAV resource has one latest
metadata entry or deletion tombstone; full event/contact content remains only in its
canonical table. No canonical mail, event, contact, user override or body cache is deleted.
No-op event/contact updates do not advance DAV versions. ICS/CardDAV and native Google/
Microsoft projection writes also compare actual columns, avoiding unnecessary tuple and
index writes. A missing provider modification timestamp no longer changes DTSTAMP on
every poll, and an exact iCalendar replay is not reserialized into a different ETag.

The normal startup migration sequence is **0146 → 0147_mail_prefetch_backoff.sql →
0148_graph_reader_body_completeness.sql**, after all existing migrations through 0145.
These are new migrations; prior files/checksums are unchanged. The migration is a metadata
cutover, not a multi-GB rewrite. **Upgrade all backend instances together**: an old worker
cannot safely serve the new compact journal layout. Every existing DAV collection advances
its minimum token once. Old DAV tokens receive `403 DAV:valid-sync-token`; a full sync
returns the original canonical resources. Do not downgrade to a pre-0146 backend against
this schema; restore the pre-upgrade backup for a true rollback.

Ten seconds after HTTP startup, a single-flight worker checks retired journal files,
legacy headers and due retention work. It operates in bounded transactions, checkpoints
header data and progress atomically, yields between batches, and retries after contention.
A restart resumes the saved cursor rather than repeating/counting committed work. Each failing
account/collection receives its own persisted retry deadline, so one locked or slow resource
does not starve other accounts, journal retention or security-log cleanup. Header
payloads are fetched individually (50 rows per transaction, 16 MiB per-payload safety limit).
Ambiguous/invalid UTF-8 or oversized legacy values are reported and left intact.

Retired journal tables are truncated **only after** the transactional DAV token cutover.
They contain no canonical data and receive no further writes from the new build. This
releases their heap/TOAST/index files with a short lock timeout and no `CASCADE`. Current
journal entries are retired after 30 days or when a collection exceeds 10,000 entries,
in batches of 500; an atomic minimum-token advance makes older clients resynchronize.
The cap is an eventual retention target between worker passes, not an insert-time limit.
Token, floor, latest state and canonical payload in each incremental report are read in
one PostgreSQL snapshot as separate rows (not one size-limited aggregate JSON value), so a concurrent writer/cleanup cannot silently hide a change.

Operational cleanup retains authentication audit for 90 days, conversation rebuild audit
for 30 days and resolved conversation-ingest failures for 7 days. Each pass processes at
most 500 records per table. Completed domain-outbox payloads older than 7 days are cleared,
but the delivery deduplication key is retained. Pending/failed/uncertain operations, send
receipts, provider cursors and spam-training examples are not treated as disposable logs.

## Mail content and prefetch

Body prefetch existed in upstream MailFlow and predates Inboxora's TypeScript migration.
The new policy keeps the useful latency optimization without automatically reading the
whole historical mailbox: at most **three visible messages**, **two active accounts per
process**, and **one request stream per account across replicas**. Cached messages and
recent failed/empty/oversized reads are skipped. Provider retry hints can extend the
account cooldown; a failure stops the rest of the speculative batch.

IMAP, native Gmail API and Microsoft Graph use the same visible-view scheduling policy,
with their own transports and existing provider safety exceptions (including sensitive
IMAP providers). Normal IMAP sync and historical backfill fetch metadata by default.
Historical snippet scanning is explicitly opt-in. Missing bodies remain available when
opened; snippets may remain blank until a visible/foreground read or a rule needs them.
Existing cached bodies are not evicted or rewritten by the upgrade. Enabled IMAP body
rules explicitly read an uncached message when evaluating it; this is required feature
data, not background prefetch. Native Gmail/Graph retain their durable rule-hydration
paths. Failed or empty reads, changed/moved copies and oversized HTML-only input remain unknown
and cannot trigger a negative body condition. Required reads do not enable full-history
prefetch or fall back to IMAP on a native Google/Microsoft account.

Gmail warms the complete MIME body plus attachment metadata; bounded CID data can be
embedded. Graph warms only its body; the normal reader obtains attachment metadata/CID
parts on opening, without downloading ordinary attachments just for prefetch. A new
Graph body-completeness marker distinguishes this full read from rule-only text extraction.
Late background results cannot overwrite a foreground cache, a changed message or a
revoked/switched account binding. Neither warming path marks provider messages as read.
The 2 MiB budget limits the cached speculative result, **not all bytes transferred by a
provider response**. Ordinary attachment downloads, drafts/sent bodies, rules and foreground
reading retain their existing behavior. This is not an offline archive or a body-retention
feature, and it does not delete legitimate cached content to make a size report look smaller.

## Operator procedure and before/after measurements

Back up the database before deploying; background repair starts automatically on the new
image. The build is validated on synthetic databases, but the maintainer's production test
must still run before inviting the reporter and publishing 4.1.2. No manual `--apply` is needed.

For the maintainer's current installation (DB/user `mailflow`):

```sh
# Before replacing the backend; keep the backup private.
(umask 077; docker exec inboxora-postgres pg_dump -U mailflow -d mailflow -Fc > "$HOME/inboxora-before-4.1.2-$(date +%Y%m%d-%H%M%S).dump")

# After the new dev image starts, this is read-only and can be repeated:
docker exec inboxora-backend node dist/scripts/storageMaintenanceStatus.js --summary
```

The report distinguishes `database_before_bytes`, the currently allocated database file
sizes, actual retired-journal bytes released, and **uncompressed logical header savings**.
Never add the logical header number to physical journal bytes as a forecast. Normal sync
activity can change the current size while the repair runs. The full status command without
`--summary` includes per-task checkpoints and skipped values; logs use `[storage-maintenance]`.

Ordinary background VACUUM makes repaired header pages reusable and may release empty tail
pages. It has a dedicated 10-minute maintenance budget rather than the short request
timeout; cancellation or contention schedules an hourly retry rather than repeated restarts. It does **not** guarantee immediate physical shrinkage of `messages`. No automatic
`VACUUM FULL` is performed: it requires a table-wide exclusive lock and extra working space.
The compact-journal cutover does release the retired journal files without such a mail-table
rewrite. PostgreSQL allocated file size, uncompressed column bytes, WAL, host filesystem
allocation/compression and container logs are separate measurements.

Defaults require no new environment settings. `STORAGE_MAINTENANCE_ENABLED=false` pauses
data-repair/DAV-retention tasks (not the schema/token cutover); the lightweight
privacy/operational-history retention pass remains active; `MAIL_BODY_PREFETCH=off` disables speculative
body reads; `IMAP_HISTORICAL_SNIPPETS=true` explicitly restores historical snippet scans.
Both standard Compose files expose these switches and rotate stdout/stderr logs at
three 10 MiB files per service. A **custom existing Compose file is not changed by pulling
an image**; its Docker logging policy must be updated/recreated separately.

## Verification gates

Coverage includes real PostgreSQL no-op updates, Google/Graph/CardDAV replays with unchanged
physical tuples, missing provider timestamp stability, DAV rename/delete/full-resync behavior,
retention floors, tenant isolation, concurrent workers, bounded header repair and rollback,
retired-file reclamation, visible-body limits/cooldowns and late-read fences. A paused-worker timer regression verifies that auth retention still runs without starting
header repair. A populated
0145 database upgrade test runs the actual startup scheduler, interrupts after one header
batch, restarts it, and verifies exact canonical IDs/content and measured file reduction.

Backend typecheck/lint/build, full unit tests, service-dependent PostgreSQL tests and GitHub
CI must pass for the published dev SHA. Then test the maintainer's real database. Only after
that should the reporter be asked to verify; no stable release is authorized by these notes.

## Desktop PWA

This planned release also includes the already-integrated desktop window-controls-overlay
changes: the title-bar drag strip and scaled mail viewport follow live overlay sizing.
This storage follow-up does not introduce another frontend redesign.

## Dev image publication

Manual `dev` publication validates an immutable source SHA against the explicitly selected
repository branch. AMD64 and ARM64 images are built on native GitHub runners rather than
QEMU. Platform jobs push immutable digests only; the shared `dev` tags are updated only after
both architectures and both component manifests pass verification. A single-platform build
can no longer replace the shared multi-platform tag. Built backend images execute both
maintenance CLI `--help` checks before promotion. Stable/versioned tags are not changed.
