# Release notes 4.1.2 — draft

**Status: unreleased; dev verification only.** No version tag, package version bump or
production deployment is part of this change. Release only after the maintainer's
existing database test and the original #16 reporter's confirmation.

## Account and unified-inbox navigation performance

Changing accounts previously discarded the visible list and waited for the next HTTP
response on every visit. Returning from Calendar/Contacts retained the mounted live
mail view, explaining why that path felt faster. Recently visited first pages now
render immediately from an in-memory snapshot, then always revalidate with the API.
The key includes the complete list query (account, folder, unread/category filters,
thread grouping and page size) and is isolated by authentication epoch.

Snapshots are not persisted: at most eight query entries and 1,000 total metadata rows
are retained for at most five minutes. Offset pages and large infinite-scroll windows
are not added to this navigation cache. Local mail mutations, account/configuration
changes and live invalidations evict obsolete snapshots and fence older in-flight
responses. Logout, lock and session changes clear them. Known-scope flag/read/delete/undo operations invalidate all affected accounts and
unified snapshots, including their in-flight writes, while preserving unrelated
account snapshots and pending revalidations. Incomplete or unknown scope falls back
to global invalidation. Writes invalidate matching snapshots and pending tickets
both before sending and after settlement, including failed or interrupted writes;
late completion from an older authentication epoch cannot clear a new session.
Local message-count-only corrections do not discard the navigation cache. Body-access bookkeeping does not invalidate useful navigation data. A cold view intentionally shows loading rather
than another account's mail; a warm view keeps its last snapshot on a transient refresh
failure. It is not considered fresh until revalidation succeeds.

Navigation aborts superseded list HTTP requests, including pagination/background
loads; a late completion cannot clear the new view's loading indicator. Returning
from Calendar/Contacts still preserves the mounted live view and loaded pages. Native
thread expansions are not restored from the navigation snapshots. Their reconciliation
is bounded by server list generations rather than row-object identity, so optimistic
flags and count corrections do not repeatedly fetch a removed representative.
Explicit read/unread intents continue for the same authenticated user after account
navigation, while their old expansion cannot be written into the new view.

Before the navigation fix, a browser regression with its revalidation response held
open showed zero rows on return to the already visited unified inbox. After the fix,
account/unified snapshots render before that response is released, on desktop and
mobile. These controlled API tests establish removal of the HTTP wait from warm
navigation; they are not a measurement of production Microsoft/Gmail/IMAP latency.
Unit coverage checks cache lifetime/size, scoped keys, invalidation and stale-session
responses. There is no new backend migration, setting or provider polling introduced
by this navigation change.

## Thread expansion and read state

Mailbox pagination does not limit the number of children in an expanded native thread.
A stale frontend expansion could nevertheless show 14 cached messages after the mailbox
list had refreshed to 17; marking the whole thread read could then act on only those
14 cached IDs and leave the three newer replies unread.

Expanded membership is now reconciled when the current list row no longer matches its
cache. Explicit whole-thread read and unread actions fetch a current server membership
snapshot rather than trusting an older expansion. Their intent and completion follow
the account-local thread even when an unread/filter refresh changes its representative
message. Superseded expansion responses cannot overwrite the action's membership, and
late loads are checked against their authenticated view and component lifetime.
Only an expanded row is automatically reconciled; collapsed mailbox rows do not each
trigger a thread request. A list response that races a whole-thread write is fenced
and revalidated after completion, so an older aggregate cannot restore the unread
badge. Final aggregates include any newer cached replies rather than silently marking
them read. This extra list-only revalidation is conditional on an actual request race. An inconsistent/transient server snapshot is retried on a
later list snapshot or refresh hint, not in a render/request loop.

These are frontend changes using the existing authorized thread/read endpoints; they
add no migration, setting, provider resync, or mailbox-data rewrite. Replies arriving
after the action's resolved snapshot are still new messages, not silently marked read.
Existing folder-copy deduplication and provider read-write semantics are unchanged.

Validation on ubuntu-dev includes a failing-before/passing-after browser reproduction
of the 14/17 mismatch and incomplete read action, plus desktop/mobile regressions for
read/unread cycles, delayed expansion responses, replacement representatives, bounded
reconciliation and a 101-message expansion. These browser tests use synthetic mailbox
responses against the built application; they do not claim validation against the
maintainer's live Microsoft mailbox or provider-side delivery.

The final local pass also covers write-completion cache fences on success, HTTP
failure and interrupted requests, preserving unrelated accounts and newer sessions.
The mocked mailbox now commits successful read writes before returning success, so
reader revalidation is checked against the resulting state rather than an immutable
unread fixture. Delayed-response tests wait for the socket's initial catch-up and
identify the exact held request, without relaxing their membership assertions.
The focused desktop/390px mobile browser run passed 109 cases (49 existing
viewport/mode exclusions); the full frontend unit suite passed 3,229 cases. These
local results do not substitute for the exact-commit GitHub CI and CodeRabbit gates
before publishing the development images.

## Follow-up after the first development acceptance test

The first development build did not cover two production-like paths reported by the
maintainer. Seven new desktop/mobile browser checks reproduced failures before these
follow-up changes. Opening the final unread non-head child, or marking it individually,
left all 17 children read while the parent remained unread: the single-copy caller had
included an `unread_count` override reserved for whole-thread actions. Single-copy writes
and rollbacks now update only physical read state; the store derives the parent from
complete membership or applies a known-copy delta for an incomplete expansion. A singleton
updates its own badge even without expansion. These tests also run with the unread filter
active and block subsequent list requests so eventual revalidation cannot mask the defect.

Navigation tests now include offscreen server flag events and waking the application,
not just a quiet mocked mailbox. Bulk-read broadcasts are partitioned by their already
verified account. The frontend retains that scope when the physical copy is not loaded,
and reader writes/count refreshes carry their known account too. Thus an event concerning
one account no longer discards all previously visited accounts. A visibility/online or
periodic freshness check retains the bounded navigation snapshots while still
requesting current list/count data; concrete mail changes still hard-invalidate affected
snapshots and in-flight results. Snapshot retention is five minutes rather than
one minute, so another account does not become cold during a normal reading session;
navigation still always starts an immediate API revalidation, and expiry never grants
freshness. Row/entry limits and query isolation remain bounded. Lock/logout protections, query separation and write
completion fences are unchanged. No migration or provider-side read/write behavior changes
are included in this follow-up.

The new failure cases passed 28 repeated desktop/mobile checks after the fix (the native
desktop context-menu case has no equivalent browser right-click on mobile). The actual
native-list service was also measured locally with 30,000 synthetic PostgreSQL messages:
warm account reads took about 11–21 ms and unified reads about 29–41 ms. This did not
reproduce a slow database query and is not a production performance measurement. Public
version metadata confirmed that the reported live instance was already on the previous
`a7ee6598` build, so the report was not attributed to an old installation. Production
mailbox contents and provider acknowledgements were not accessed in these tests; the
maintainer's acceptance test remains required before release.

## Microsoft Graph compatibility aliases and phantom unread rows

A real PostgreSQL + HTTP regression reproduced an additional server-side cause:
17 native Graph messages were read, while four verified legacy IMAP aliases still
had unread flags. The physical unread counter returned four, and the unread filter
and thread expansion could select different physical rows for the same bound mail.
This was not merely a frontend cache discrepancy. The inverse state (four native
messages unread but their aliases read) also produced inconsistent expansion flags.

A shared read projection now excludes only a verified compatibility alias whose
canonical provider message is present, non-deleted, in the same account and current
native Graph connection, and in the same folder or backed by a confirmed provider
move. Lists (including pagination/counts), expansion and unread counters use the
same rule before applying unread filtering. Diagnostics apply the same alias rule.
No rows are deleted and no read flags are rewritten by this projection; old UUID
body links still resolve. Missing/ambiguous bindings, changed connections, IMAP
fallback, deleted/missing canonical identity and unconfirmed moves preserve recovery
visibility. Same RFC Message-ID without a verified binding is not enough to exclude
anything. No migration, provider poll or historical resync is required.

Integration tests include both 17/4 divergences, flat/threaded/unread views, retained
legacy links/rows, invalid binding guards, confirmed moves and HTTP read/unread/read
cycles using canonical IDs against a mocked Graph HTTP boundary. Those cycles return
0/17/0 unread and preserve all 17 children. Provider transport behavior itself is not
changed, and no live production provider acknowledgement is claimed. The projection
was also exercised with the actual list service on an isolated 30,000-message test
database; EXPLAIN confirmed indexed canonical lookups rather than per-row provider requests, with
warm scoped/unified requests in tens of milliseconds on this development server.
These timings are not a production latency guarantee.

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
These are new migrations; prior files/checksums are unchanged. Migration 0149 adds the administrator-configurable idle-cache retention described below, after 0148. The migration is a metadata
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

Operational cleanup defaults to authentication audit for 90 days, conversation rebuild audit
for 30 days and resolved conversation-ingest failures for 7 days; administrators can now change these values in Performance. Each pass processes at
most 500 records per table. Completed domain-outbox payloads older than 7 days are cleared,
but the delivery deduplication key is retained. Pending/failed/uncertain operations, send
receipts, provider cursors and spam-training examples are not treated as disposable logs.

## Mail content and prefetch

Body prefetch existed in upstream MailFlow and predates Inboxora's TypeScript migration.
The new policy keeps the useful latency optimization without automatically reading the
whole historical mailbox: **25 visible messages by default**, **two active accounts per
process**, and **one request stream per account across replicas**.
Administrators set **0–100 messages** in **Settings → Administration → Performance**;
**0 disables prefetch**. The setting is persisted in the existing `system_settings` table
under `mail_body_prefetch_limit` and is read for every new batch on every backend, without
restart or a new schema migration. An already-started batch may finish with its original
limit. `MAIL_BODY_PREFETCH=off` is a server-level override, shown explicitly in the UI.
The limit describes the first messages in the current folder list, not parallel requests
or a global cache-size cap. Already-cached messages do not cause older rows outside that
window to be fetched. Messages are warmed in display order, one at a time per account.
Changing the limit does not delete existing cached bodies or change the 2 MiB per-message
speculative cache budget. The same value applies to IMAP, Gmail API and Graph, subject to
their existing provider safety exceptions. Larger windows trade more network/database
work for more messages likely to be ready before the reader opens them; this is not a
measured latency guarantee.
 Cached messages and
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
reading retain their existing behavior. The prefetch policy is not an offline archive. Separate idle-cache retention is now configurable as documented below; its logical cache savings are reported separately from physical journal reclamation.

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

Each later header-repair batch re-arms a previously completed VACUUM immediately; a stale completed/delayed VACUUM checkpoint cannot leave the initial sweep permanently pending.

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

## Global retention settings and idle body caches

Settings → Administration → Performance now contains a separate **Data retention** form.
The administrator configures all users globally; ordinary users cannot read or modify it.
Changes are validated before any write, saved atomically, and reschedule the next bounded
cleanup batch without restarting. Invalid stored settings stop cleanup instead of guessing.

Defaults: body cache **30 days** (0 = no expiry), DAV history **30 days / 10,000 latest
entries per collection**, authentication audit **90 days**, conversation rebuild audit
**30 days**, resolved ingestion failures **7 days**, completed internal outbox payloads
**7 days**. Day limits are 1–3650 except cache (0–3650); the DAV count range is 100–100,000.
Expanding a retention period cannot recover logs already removed. Pending/uncertain delivery,
provider operation state, deduplication receipts, canonical events/contacts and messages
are not disposable log history. Custom Docker logging still requires host Compose changes;
this form does not control Docker stdout/stderr retention.

Apply new migration **0149_body_cache_retention.sql after 0148** using normal startup.
It adds cache/access timestamps, a bounded-cleanup index and a body-write trigger. Old
cache timestamps start at the upgrade, not the message's sent date or its Seen flag, so
there is no immediate bulk eviction of long-standing caches. The migration also re-arms
the already-deployed stale `needed=true`/completed VACUUM checkpoint.

The worker clears only `body_text`/`body_html` (including inline data-URI images) after the
configured idle period, using the later of last body opening and cache population/change.
Mail remains in the message list and on the provider. Snippets, threading/raw headers and
attachment metadata remain. A subsequent ordinary body request fetches it through the
account's IMAP/Gmail/Graph transport and caches it again. Browser-memory revisits explicitly
record an opening too. Synchronization, marking unread and background prefetch are not
openings. Previously evicted bodies are excluded from speculative list prefetch until an
explicit opening, preventing an evict/prefetch loop. Required feature reads, including
inbox rules, continue independently of speculative warming.

Cleanup takes at most 100 row locks with SKIP LOCKED per pass. A foreground opening updates
its access timestamp under the same row lock; cleanup cannot clear that newly accessed
row. Zero disables expiry. Drafts/composer state, nonpositive or unverified IMAP UIDs,
unbound native identities, disconnected provider accounts, pending source removals,
body-dependent rule work and row-linked pending/uncertain operations are excluded.
Durable send-idempotency receipts are never expired or changed by cache cleanup; an
unrelated unresolved send does not freeze all caches belonging to its owner. Outgoing
messages use the composed request, not a body cache linked to such a receipt. This is a local
cache, **not an offline archive**: remote access must still be available for a later refill.
Backend expiry does not remotely erase an already rendered browser-memory copy.

Read-only status includes `body_caches_evicted`, `body_cache_logical_bytes_saved` and per-task
next-run times. These are logical payload savings, not promised filesystem reduction;
normal autovacuum reuses pages without a mandatory `VACUUM FULL`. Local full-text body search
has less cached material after expiry, although subject/snippet metadata remains searchable.

Validation covers configuration boundaries/authorization, 7/30/0 policy changes, native
provider bindings, protected drafts and pending work, real HTTP cache reads/refills,
concurrent opening vs cleanup, prefetch-loop prevention and safe upgrade timestamps.
No production database is modified by the development tests.
