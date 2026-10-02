# Inboxora 4.2.0

Released **30 September 2026**. This feature and reliability release contains the changes
since 4.1.2: scheduled sending and mail merge, sender/recipient defaults, unified account
settings, more reliable provider synchronization, and follow-up storage repairs.

[Downloads](https://github.com/Dragonk/Inboxora/releases/tag/v4.2.0) ·
[Changelog](https://github.com/Dragonk/Inboxora/blob/v4.2.0/docs/CHANGELOG.md) ·
[Upgrade guide](Upgrading.md#upgrading-to-420) · [Archive](Archive.md)

## Sending and sender identities

### Schedule send, Undo Send and mail merge

The arrow beside **Send** opens **Schedule send** and **Send mail merge**. Undo Send is a
server-saved personal preference with **0, 15, 30 or 60 seconds**; zero keeps immediate
sending. Previously saved intermediate delays remain valid until changed. The countdown
survives a client reload. Schedule Send uses the browser's time zone, checks the deadline on
both client and server, and rejects nonexistent or ambiguous daylight-saving local times.

**Scheduled** is a normal sidebar destination with the same list, reading pane, safe HTML
preview and attachment controls as the inbox. Selecting a message is read-only. **Edit**
atomically pauses it: passing its original deadline, autosaving, closing the editor or
restarting the backend cannot send it. Choose Send or Schedule send explicitly to resume.
Cancellation before submission removes the queued content and hides the entry immediately.

Queued bodies, signatures, attachment bytes, sender identity and reply context are saved
server-side. The browser or native app may be closed, but the backend, database and sending
provider must be available for delivery. Pending messages resume after server downtime.
The queue permits at most **100 active entries per user** and **100 attachments per queued
message**, with the normal provider and installation byte limits still enforced.

Mail merge deduplicates addresses across To, Cc and Bcc and creates one independently queued
message per recipient. Each delivery has only that recipient in To and no Cc/Bcc. It preserves
the selected sender, body, signature and frozen attachments. It is private-copy delivery,
not a template-personalization engine. Batch preparation/enqueue is atomic and a repeated
request after a lost acknowledgement reads its existing receipt rather than sending again.
The endpoint now accepts the same attachment-aware JSON window as ordinary sending.

A sent result stays visible until the user actually sees its status in the active Scheduled
view, remains for that visit, and disappears on a later visit. Background tabs, polling and
offscreen rows do not acknowledge it. Older unseen results remain paginated. This affects
queue history only, never messages in the provider's Sent folder.

**Undo and cancel are not recall.** Once a provider submission may have begun, an ambiguous
result becomes **Uncertain**, not an automatic retry. Check the provider's Sent folder before
composing another copy. Dismiss removes the uncertain queue payload without claiming to recall
or resend it. Confirmed partial delivery retains only definitely rejected recipients for a
deliberate retry. Paused, failed and partial payloads remain available to their owner; confirmed
sent/cancelled payloads are purged, while small duplicate-prevention receipts remain.

### Default From, CC and BCC

**General → Accounts → Sender addresses** includes the protected primary address and
configured aliases, with one default per account. New messages and forwards use it; explicit
selections and saved drafts keep their existing identity. Replies prefer the configured alias
actually contacted, using delivery metadata and To/Cc before falling back to the outgoing
sender. Provider address objects with either `email` or `address` are accepted consistently.

Removing the default alias returns the default to primary. An already explicit selection or
saved draft referencing a removed alias requires reselection rather than silently revealing
another address. Provider send-as authorization is still required; Inboxora does not create
provider aliases or grant send-as access.

Default CC/BCC fields appear below the signature in the account's General editor. They are
shared by its primary address and aliases, stored centrally, and shown as removable composer
chips. Each list accepts up to 50 bare addresses. Duplicates are avoided; a default listed in
both fields is added only as BCC. Switching accounts replaces only untouched automatic
recipients. Drafts, manual edits and partial-delivery retry recipients remain unchanged.
These are composer preferences: a worker never silently inserts recipients at send time.

## Accounts, calendar and native interface

**General → Accounts** is the home for mail and DAV connections. CalDAV/CardDAV discovery,
credentials, service switches and source intervals are managed as one DAV account, with
independent calendar and contact enablement. Existing sources are grouped without recreating
their data; a failure for one user does not stop every user's startup migration. Only
sources with matching usernames, decrypted credentials and verified server scope are grouped;
different or unverifiable identities stay separate. Pausing a DAV service retains its data,
and renaming its account does not reactivate a paused source.

Mail editors have General, folder mappings, sender addresses and diagnostics subpages.
Folder mapping drafts survive tab changes. Diagnostics distinguish requested/completed
reindexing, real folder synchronization and failures, including native mail's own last
successful run rather than a recent calendar/contact success. Native reindex requests run
under the provider worker's lease, not through IMAP. Interrupted IMAP reindexing is reported
as failed after restart rather than left queued forever.

Calendars and Contacts manage collections and import/export, not another credential form.
Calendar appearance belongs in **Appearance → Calendar**, including the desktop agenda
visibility switch. The default invitation sender is selected in **General → Calendars**;
its account and alias are saved and work with SMTP,
Gmail API and Graph. An unavailable invitation alias is an explicit error, not a silent
substitution. Editors stay within the settings viewport with Back navigation; Rules and
Antispam use the shared theme-aware controls.

Windows, Linux and Android setup, menus, notification actions and Compose/Calendar/Contacts
in-app shortcuts follow the selected language across all nine supported locales. Installed
Linux launcher actions include all nine translations; the desktop environment selects their
labels using its own locale. Updating only Docker does not replace an installed native binary.
Delayed language,
theme or preference loads cannot overwrite newer choices. Android shortcuts update off the
UI thread. Notifications open their exact incoming or scheduled message, including a queued
item outside the loaded page. Mobile settings close the calendar drawer properly; reading
panes retain scrolling while message-frame heights change.

## Mail synchronization and correctness

Read/unread and star actions use durable, generation-checked state across **IMAP, Gmail API
and Microsoft Graph**. Bulk actions persist every member before provider calls start and
report confirmed, pending and failed results separately. The latest explicit click wins.
A connection or token failure before dispatch can retry; an uncertain IMAP STORE is read back
against the exact UIDVALIDITY instead of blindly repeated. Recovery survives backend restarts
and does not depend on a recent-message window or persistent IDLE connection.

Flag observations deferred during optimistic UI protection are checked again independently
of Graph delta, Gmail history or IMAP MODSEQ. Gmail UNREAD/STARRED labels, physical folder
copies and unread/category totals follow the same evidence. Thread expansion and the
conversation reader retain distinct physical copies while hiding only proven Graph aliases.
Messages with genuinely empty subject/preview metadata remain visible. A disabled, missing
or unowned requested account never widens the query to somebody else's or the unified inbox.
Late responses cannot overwrite a later account, session, selection or read/star action.

Gmail history and baseline imports now continue when an exact referenced thread was deleted.
Authentication, throttling and server failures are not treated as empty mailboxes. Deletion
still needs explicit provider evidence or a completed baseline, guarded by the active worker.
Missing label count fields no longer zero badges; removal of a label preserves a labelless
message in Archive. Failed optional Graph visibility recovery backs off without blocking
normal mail synchronization. IMAP folder-count or timestamp persistence failures no longer
report a successful reindex/sync.

Gmail and unified lists use account-scoped membership sets instead of repeated per-message
label lookups, avoiding expensive plans while preserving list, unread and category results.
Reply-To survives both readers. MIME generation uses structured addresses, so punctuation or
address-like display names cannot redirect Gmail recipients. An accepted provider submission
is not proof of delivery to the destination mailbox.

## Calendar and contact collection lifecycle

Complete, validated provider/DAV discovery removes local projections of collections confirmed
missing at their source, including their owned events/occurrences or contacts. Contact
membership in another book is preserved, including CardDAV merge/skip policies. Partial
pagination, malformed responses, revoked access and changed credentials cannot authorize
cleanup. Google discovery includes hidden calendar subscriptions; Microsoft primary contacts
and secondary folders retain separate identities. CalDAV verifies a missing collection.

A newer complete discovery can restore a collection whose prior absence was recorded by
discovery. It does not resurrect a confirmed user deletion or re-enable a disabled calendar.
Small tombstones and operation receipts preserve this distinction across restarts and races.

Remote deletion is available only for supported writable secondary Microsoft address books,
owned secondary Google/Microsoft calendars and eligible DAV collections. Exact-name
confirmation and an acknowledgement of remote content removal are required. Primary,
shared/non-owned and unverified collections remain protected. An uncertain deletion exposes
**Check operation**, which checks the same receipt rather than dispatching another DELETE.
Local disconnection is separate. Google People has no deletable address-book container;
Inboxora does not substitute deleting all contacts or a contact group.

## Storage repair and native-account host errors

### Large-account header repair

The automatic legacy-header repair introduced in 4.1.2 could spend its final pass searching
large stretches of already-correct headers and repeatedly end with PostgreSQL cancellation
`57014`. The corrected worker first selects a cheap **250-row account/UUID page**, then
inspects only those headers. It decodes at most **50 payloads / 32 MiB** per batch, with
16 MiB per payload. Dense pages checkpoint the last inspected row, not an unprocessed tail.
Existing UUID checkpoints resume safely; completed accounts are not rescanned every day.

Migration **0165** builds the dedicated `(account_id, id)` index concurrently. It does not
index message contents or rewrite messages; an interrupted build can be retried. Check
progress without modifying data:

```sh
docker exec inboxora-backend node dist/scripts/storageMaintenanceStatus.js --summary
```

`header_scan_rows` may increase while `headers_repaired` stays unchanged: correct rows still
need inspection. `header_tasks_pending` and `header_tasks_with_errors` distinguish remaining
work from failures; omit `--summary` for failure stage and retry time. No cursor reset is needed.
Compare the reported database size only after **`initial_sweep: complete`**, then observe whether
abnormal growth returns during normal use.

Logical header/cache savings are not additional measured disk savings. Ordinary VACUUM can
make pages reusable without shrinking the files; the one-time repair may temporarily increase
allocated space. This release does **not** automatically run VACUUM FULL, delete mail, promise
a specific size reduction or make unsafe table rewrites on a nearly full disk. Existing
administrator prefetch and retention settings are preserved.

### “Host must be a string” after migrating to Google or Microsoft

An obsolete IMAP callback could run after the account had switched to Gmail API or Graph,
try to resolve the correctly removed IMAP endpoint and store this error while native sync
continued. Connection setup now checks the owned account's current transport/generation;
retired callbacks and in-flight handshakes cannot install an obsolete socket or write legacy
health over a native account. Genuine IMAP failures remain visible.

Successful cutover clears its old IMAP status atomically. Migration **0166** removes only the
exact `Host must be a string` artifact from already-native Gmail/Graph accounts. Provider
connection/grant diagnostics, unrelated errors, credentials and mail/calendar/contact data
remain intact. Refresh the account list after upgrading. No account recreation, new consent,
dummy IMAP host or mailbox reset is needed for this fix.

## Upgrade requirements

Back up PostgreSQL and the matching `.env`/encryption key. Preserve the existing database
name, role and persistent volumes, particularly on deployments migrated from MailFlow.
Update all backend replicas and the frontend together; do not mix old workers with the new
schema. Use PostgreSQL **16**, as in the supplied Compose configuration. Source builds use
Node **22**; the updated Nodemailer requires Node 20 or later.

From **4.1.2**, normal startup applies these pending files in order before serving requests:

| Migration | Purpose |
| --- | --- |
| `0150_account_default_sender.sql` | Same-account default sender reference; existing default remains primary. |
| `0151_account_default_recipients.sql` | Default CC/BCC arrays, initially empty. |
| `0152_scheduled_mail.sql` | Durable queue, claims, revisions and idempotency. |
| `0153_scheduled_mail_dismissal.sql` | Explicit terminal dismissal of uncertain queue entries. |
| `0154_mail_merge_batches.sql` | Atomic batch receipts and safe acknowledgement replay. |
| `0155_scheduled_mail_seen.sql` | Viewed Sent-result acknowledgement and small headers, not another body archive. |
| `0156_mail_flag_state.sql` | Durable mail flag intent/readback state. |
| `0158_native_collection_retirement.sql` | Provider collection lifecycle metadata. |
| `0159_dav_collection_lifecycle.sql` | DAV collection lifecycle metadata. |
| `0160_mail_flag_upgrade_readback.sql` | Bounded observation of historical flag discrepancies. |
| `0161_collection_rediscovery.sql` | Discovery provenance and safe restoration. |
| `0162_settings_mail_diagnostics.sql` | Folder-sync and reindex progress timestamps/errors. |
| `0163_unified_dav_accounts.sql` | Shared DAV account/source associations. |
| `0164_calendar_invitation_aliases.sql` | Persisted invitation sender alias. |
| `0165_header_repair_scan_index.sql` | Retry-safe concurrent header-scan index. |
| `0166_native_account_stale_imap_error.sql` | Narrow cleanup of false native-account host errors. |

There is deliberately no 0157 file. Earlier versions first apply their intervening migrations;
do not skip files or edit recorded checksums. A tested dev deployment that already applied
these exact migrations does not repeat them. No new environment variables or blanket provider
consent are required. Remote write/delete actions still require existing provider permissions
and collection write-back. Undo Send defaults to disabled; existing defaults and preferences
are retained. Restore the matching backup for a full rollback rather than assuming that an
older image understands the migrated schema and delivery queue.

Docker images are `ghcr.io/dragonk/inboxora-backend:4.2.0` and
`ghcr.io/dragonk/inboxora-frontend:4.2.0`, also available as `latest` and `v4.2.0`, for Linux
AMD64 and ARM64. Pin `INBOXORA_VERSION=4.2.0` with the supplied Compose; custom Compose files
may use another variable such as `VERSION_TAG`. See [Upgrading](Upgrading.md).

## Packages, security and verification

Release packages cover Windows, Linux DEB/RPM (x64 and ARM64), and Android APK/AAB. They are
built from the release tag using the existing signing workflows. Checksums, their detached
GPG signature and the documented public key accompany the app downloads. Native apps connect
to an existing Inboxora server; Android closed-app notifications still require a configured
UnifiedPush distributor. No macOS package is included in this release.

The backend updates **undici 6.29.0**, **Nodemailer 10.0.13** and **brace-expansion 5.0.12**.
The high-severity dependency-audit gate remains enabled. SMTP result/connection types use
Nodemailer's explicit definitions; TLS, endpoint validation, BCC privacy and uncertain-send
handling are not weakened. Remaining moderate advisories are not claimed fixed. The separate
GitHub-managed AI scanner has been failing before analysis with an unsupported-model error;
that service failure is not reported as a successful security scan.

Regression coverage includes owned-account/transport races, blocked status writes, both
native cutovers, MIME/recipient privacy, queue interruption and replay, source deletion and
rediscovery, mailbox isolation, sparse/dense header scans, both historical database upgrade
paths and desktop/mobile UI behavior. PostgreSQL fixtures and controlled provider/SMTP
boundaries are used rather than sending real user mail. The published dev backend was also
started against a schema-0165 fixture and verified to clear the false host artifact while
preserving real errors, messages, events and contacts. Final release builds are recorded in
GitHub Actions on the tagged source; this is not a guarantee against every provider-specific
or device-specific issue.

## CI and release delivery

Documentation-only changes run the documentation/link/version checks, not the browser or
database suites. Unknown paths, application code, dependencies, fixtures and CI configuration
still select full validation; manual workflow dispatch always runs the full selected workflow.
When an open same-repository PR targets dev/main at the exact pushed head, its merge-revision
checks cover that push, so a second heavy push matrix is unnecessary. Standalone dev pushes
remain tested. Failed change detection does not silently skip tests or pass the final gate.

The full five-project Playwright set is partitioned into four isolated shards, each with one
worker and the same retries, browser settings and visual thresholds. All four must pass the
existing named check; their reports are combined. No tests are removed. Unit tests run in CI
rather than being repeated inside the browser workflow. Mocked browser jobs no longer start
an unused PostgreSQL service. PostgreSQL upgrade, regression and 10k/50k/100k EXPLAIN scale
validation run on three separate service instances, avoiding shared mutable fixtures. They
install backend dependencies only and retain all existing migration and data-safety checks.

Versioned Docker images use native AMD64/ARM64 runners. Both architectures and both component
manifests are verified before promotion to the release tags; `latest` is promoted only for a
stable version matching main. App signing builds use a validated existing tag and attach to
a draft release, which is published after artifact verification. The release helper no longer
suggests a direct push to main or creates an unreviewed version-bump commit.

The native packaging workflow explicitly preserves repository LF bytes before checkout,
including on Windows. Generated locale assets are still checked byte-for-byte; their
freshness test is not skipped or regenerated over. A build-workflow-only correction may
run from a newer main revision while checking out and validating the original immutable
release tag for every app artifact. This does not move the release tag or mix app sources.


## Development follow-up: native MCP (not part of the published 4.2.0 images)

The development image adds `/mcp` using Streamable HTTP. ChatGPT-compatible clients can
use OAuth authorization-code/PKCE with discovery and dynamic client registration.
Mistral Vibe and other static-credential clients can use a separate revocable Bearer
token. Settings → AI exposes MCP permissions to every user; installation-wide built-in
AI configuration remains administrator-only. See [MCP setup](../MCP.md) for client
configuration, permissions and operational limits.

Tools cover email search/read/threading, attachments, drafts, sending/replies/forwarding,
mail organization, calendars/recurrence/availability and contact CRUD. Existing source
write-back permissions still apply. Imported/read-only calendars are readable but cannot
be silently edited. Importing an email invitation is not an RSVP. Availability describes
the user's synchronized calendars, not other people's live schedules.

Enable `MCP_ENABLED=true`, keep the existing `ENCRYPTION_KEY`, and set `APP_URL` to the
public HTTPS origin. Both supplied compose files pass the MCP options. Nginx forwards
`/mcp`, `/oauth/mcp/*` and OAuth metadata discovery to the backend. Direct browser clients
may additionally need an exact origin in `MCP_ALLOWED_ORIGINS`; no wildcard is accepted.
No separate proxy or AI model subscription is required by the Inboxora server.

Migration **0167_mcp_authorization.sql** follows **0166** and must be applied before the
new backend serves requests; normal startup runs it automatically. It adds isolated MCP
clients, grants, token hashes, authorization requests and encrypted operation receipts.
No existing mailbox data is rewritten. Expired requests are scrubbed, result payloads are
removed after 30 days, and an execution interrupted for over one hour is parked as
uncertain, never retried automatically. Request IDs/fingerprints remain for replay safety.

Mail search now combines cached matches with bounded server-side Gmail, Graph and IMAP
searches. It finds server-confirmed body matches without requiring a local body cache,
handles quoted phrases and literal `%`/`_`, searches recipients, and applies native Gmail
label permissions before pagination. A server failure or search cap is explicitly marked
as incomplete. Provider indexing and synchronization can still affect coverage; narrow a
query or select an account/folder when the incomplete-results warning appears.

Validation includes the full backend/frontend unit suites, real PostgreSQL and MCP SDK
HTTP/OAuth tests, source-draft MIME tests and browser tests for consent, explicit write
approval, ordinary-user settings, desktop/mobile layouts and both themes. End-user account
linking inside ChatGPT or Vibe remains a deployment acceptance check; no claim is made
that every third-party client's UI has been exercised.

MCP follow-up checks also cover empty move receipts, manual unsubscribe links, mapped Inbox permissions when marking not-spam, draft priority and OAuth `invalid_grant` after revocation. These paths no longer report an unconfirmed action as completed.

Remote search waiting now shares an eight-second budget across accounts. Slow providers return an explicit partial-results warning without making the local result wait for every account deadline. Already-started reads stay bounded and may populate the cache for the next search.

Research `fetch` now uses character-based `textOffset`/`maxCharacters` with a reusable continuation offset. Event searches match actual field values rather than JSON keys. Forwarded MIME types are normalized before approval, and failed MCP initialization releases its concurrency slot. Regression tests cover these cases.

OAuth token exchange and revocation support public clients (`none`), HTTP Basic (`client_secret_basic`) and form-post client secrets (`client_secret_post`). Inboxora enforces the registered method and rejects conflicting header/body credentials. All three flows are covered by the PostgreSQL HTTP integration suite.


The development MCP approval flow now treats browser approval as the final action. For mail sends, Inboxora renders a normal message preview with sender, recipients (including BCC), subject, body, signature and attachment metadata. Recipients, subject, rich message body and signature can be edited in the approval page; saving edits re-runs server-side recipient validation, sanitization, sender checks and message preparation before the preview is replaced. Approving then atomically dispatches that exact frozen version and the approval tab returns to its opener when the browser allows it. The AI client can read the durable receipt with the same request ID and cannot turn the approval into a duplicate send.

MCP composition also understands the configured sender signature as a first-class default: omit `signature` to use it, supply a per-message override, or pass an empty signature to suppress it. The final sanitized signature is what the approval preview shows and what the delivery snapshot retains.

Mail search no longer treats the first provider-response deadline as a completed empty search. Retryable partial responses keep the UI in a searching state and are retried automatically against the coalesced provider operation. IMAP search also prioritizes `\All` when the server advertises it (plus Junk separately); without `\All`, Inbox, Sent and Archive are searched before narrow folders.

AI integration settings are now grouped under **Settings → AI Features** with the same horizontal subtab pattern used by Appearance: **AI Assistant**, **AI Actions** and **External AI integrations (MCP)**. MCP is no longer nested inside the built-in assistant settings. Existing MCP connections can be expanded to inspect and change scope/resource checkboxes. These changes are live for active tokens, and Inboxora cancels pending approvals created under the previous permission set.

The mail approval editor now shares the normal composer recipient-chip and signature components. The signature remains inline below the rich message body rather than appearing as a separate settings-like text field. The redundant “reviewed exact operation” checkbox was removed: the user can edit, review the regenerated preview, then choose **Approve** or **Deny** directly. Approval still executes the exact frozen version once and closes the approval tab after confirmed completion.


CodeRabbit follow-up fixes tighten the development MCP/search implementation: dynamic OAuth registration now records the RFC default Basic client authentication method; IMAP search skips `\Noselect` namespace containers; quoted terms remain literal across local/Gmail/Graph/IMAP search; Gmail reuses already synchronized rows and fetches only missing hits. The default remote provider page budget is now the requested page plus one instead of a 200-message minimum.

MCP credentials are also protected from accidental cleartext publication. Compose binds the HTTP reverse-proxy listener to loopback by default (`APP_HTTP_BIND=127.0.0.1`), native Nginx documents a loopback/private listener, and MCP/OAuth routes on that internal hop require `X-Forwarded-Proto: https`. The shared compose signature editor now uses a stable ref callback so rerenders cannot overwrite in-progress HTML edits.
