# Development changes — unreleased

These changes are on the development branch for pre-merge testing. They are **not part of the published 4.1.2 release**; a release version has not been assigned.

## Native account migration: stale IMAP host errors

An IMAP reconnect already queued before a switch to Gmail API or Microsoft Graph could
read the newly native account, then attempt to resolve its correctly removed IMAP host.
The resulting `Host must be a string` error was saved in the legacy account status while
native mail/calendar/contact sync continued independently. A native transport does not
need an IMAP or SMTP endpoint; adding a dummy host would reintroduce the wrong transport.

Connection entry points now reject native accounts; queued startup/poll/reconnect work
re-reads the owned account. Shared pooled/new socket paths check the active transport,
host and generation before and after the handshake. Obsolete work cannot install an
IMAP session or overwrite status, and a retired timer cannot disconnect a newer IMAP
generation. Real IMAP failures are still persisted and reported normally. A provider's
own connection/grant/collection diagnostics are not hidden or cleared by this change.

Successful Google and Microsoft cutovers clear the retired IMAP status atomically with
the transport switch. Normal startup applies **0166_native_account_stale_imap_error.sql
after 0165** to clear only the exact `Host must be a string` value on already-native
accounts. No account recreation, token reset, mailbox rebuild, new permission or config
change is required. Existing messages, calendars, contacts and unrelated errors remain.
Refresh the account list after deploying the updated backend. If a different Google/Graph
error remains, treat it as a separate provider diagnostic rather than erasing it.

Regression coverage reproduces the null-host callback on both transports, stale startup
and surviving poll work, a cutover during an IMAP handshake, and a new IMAP generation
surviving an old callback. Real PostgreSQL tests check authorization, status writes blocked
on a cutover transaction, both successful migrations, and idempotent narrow data cleanup.
The public host validation and TLS checks are unchanged.

## Large-account header repair (#16)

This follow-up is based on current dev including the merged settings and folder-sync
changes. The reporter's remaining `headers:` task had error `57014` (query cancelled),
while its VACUUM task was already complete. The old query applied `LIKE '0: %'` before
LIMIT and could read most of an account's TOASTed headers just to find the next legacy
value or establish that none remained. The worker's transaction uses a 10-second
statement timeout. The logs alone do not distinguish a timeout from external cancellation,
and do not prove how much of the allocated database is reusable bloat.

The repair now limits a cheap account/UUID index scan to 250 rows, then inspects only
that page's headers. At most 50 repairable payloads or 32 MiB of encoded input are decoded
per batch (16 MiB maximum per payload). Dense pages checkpoint their actual inspected
position, never the unprocessed tail. Existing UUID checkpoints preserve their original
ordering even when UID/folder changes; experimental `v2:` UID cursors restart safely.
Already repaired values are not rewritten or counted again. Completed account sweeps
are not scanned again every 24 hours; new accounts still receive their own initial task.

Normal startup applies **0165_header_repair_scan_index.sql after 0164**. It builds a
small full `(account_id, id)` index concurrently, without indexing header contents or
rewriting messages. A retry removes/rebuilds only this dedicated index, so an interrupted
concurrent index build cannot leave an invalid index silently accepted. Existing migrations
and data are unchanged; account locks, tenant checks and atomic data/checkpoint commits
remain in place. Allow the normal migration to finish before starting the new worker.

The status summary adds `header_scan_rows`, `header_tasks_pending` and
`header_tasks_with_errors`. Scan rows count successful inspections in this implementation,
not remaining bad messages or a fixed percentage. A sparse final sweep can make progress
without increasing `headers_repaired`. Full status records failure stage and retry deadline;
it contains no subjects, credentials or message contents. No manual cursor reset is needed.

This is not an automatic VACUUM FULL or a guarantee of a smaller database file: ordinary
VACUUM makes old row/TOAST versions reusable but need not return interior pages to the
filesystem. The reporter's remaining disk allocation must be assessed after completion,
separately from the now-bounded repair and new ongoing mail activity. No remote mail,
cache policy, provider state or conversation failure records are discarded by this fix.

Regression coverage includes reversed UUID/UID order, removed cursor rows, moved copies,
same-UID folder copies, dense/sparse pages, malformed and oversized data, owner isolation,
rollback, completed-task idempotency and an existing `57014` checkpoint progressing to
completion. Existing migration/restart tests remain active.


The same dev build updates the direct `undici` dependency to 6.29.0 after the
required CI audit found a high-severity upstream vulnerability in 6.28.0. This
stays on the existing major version. Safe-fetch regressions and the unchanged
high-severity audit gate verify the update; no forced major upgrades or audit
exclusions are introduced. Existing moderate advisories in other dependencies
remain outside this storage follow-up and are not reported as resolved.


## Mail status and provider collection consistency

Read/unread and star actions share a PostgreSQL-backed intent queue across Microsoft Graph, Gmail API and IMAP, including Gmail over IMAP. The latest explicit click owns its generation. Bulk requests persist every member before the first provider call; a bounded immediate slice runs while the worker owns the remainder. Responses distinguish confirmed, pending and failed IDs. The client requests fresh evidence after uncertainty instead of retaining an optimistic flag indefinitely, and old responses cannot overwrite another session or a newer click.

Token-refresh contention and connection failures before dispatch can be retried safely. An IMAP STORE with a lost response is not blindly repeated: exact UIDVALIDITY and flag readback determine recovery. The queue survives restart and supports accounts without persistent IDLE connections. Historical unknown operations are observed, not replayed as old user commands or relabelled as historical successes.

Flags skipped by recent-change protection create durable readback work before the sync checkpoint advances. These exact-message reads are independent of Graph delta, Gmail history and IMAP MODSEQ/recent-message windows. Confirmed and observed Gmail flags also update UNREAD/STARRED metadata while preserving other labels. Folder copies are read independently rather than assigned flags from RFC Message-ID alone.

Thread expansion, conversation previews/readers and unread/category counts preserve distinct physical copies. Verified Graph compatibility aliases stay hidden with old links intact; uncertain bindings remain available for recovery. Conversation summary counts come from visible copies, not stale ingest counters. Genuine provider items with no subject, preview or RFC ID remain visible. Restoring local visibility requires current provider evidence and unchanged identity, without overriding deletion/move evidence.

### Calendars and address books

A complete validated listing can retire calendars and address books missing at their provider, along with their owned events/occurrences or contacts, collection links and relevant sync state. Memberships in another contact collection are preserved. CardDAV merge/skip policies do not send surviving contacts back into a book being retired; the same sync retains a local copy in a surviving book. Google calendar discovery includes hidden subscriptions. Microsoft contact folders and the primary contact endpoint retain separate identities. CardDAV cleanup is limited to the successfully enumerated home/source; a listed resource with an unexpected type is not considered absent. CalDAV verifies the exact missing collection before retiring its projection.

Incomplete pagination, malformed responses, HTTP errors, revoked permissions and credential changes cannot authorize cleanup. Source and collection generations fence late pages after retirement or reconfiguration. Small tombstones and operation receipts remain as recovery metadata, not visible leftover collections or another content archive. Confirmed deletions remain fenced against stale rediscovery, even after their operation receipts are pruned. An absence recorded by complete discovery may be restored only by a newer complete, authorized listing, without re-enabling a collection disabled by the user.

Collection settings offer remote deletion for supported secondary Microsoft books, owned secondary Microsoft/Google calendars and writable DAV collections. Exact-name confirmation and an acknowledgement of remote content removal are required. DAV checks the actual resource type, advertised DELETE support and parent unbind privileges. An uncertain result keeps the resource and a Check operation action; this reuses the same receipt and checks provider state rather than repeating an uncertain DELETE. Local disconnection is a separate operation. Opening settings from the mobile calendar closes its navigation panel.

Primary books/calendars and shared or non-owned calendars are protected. Google People exposes the main contact collection, not a deletable address-book container: Inboxora does not substitute deleting all contacts or a contact group for deleting the book. Existing individual-contact synchronization remains available. Provider write permissions and enabled write-back are required; unverified or unsupported deletion capabilities remain disabled with an explanation.

### Upgrade and validation

Back up PostgreSQL and deploy matching backend/frontend revisions. After the existing chain through `0155_scheduled_mail_seen.sql`, apply `0156_mail_flag_state.sql`, `0158_native_collection_retirement.sql`, `0159_dav_collection_lifecycle.sql`, `0160_mail_flag_upgrade_readback.sql` and `0161_collection_rediscovery.sql` in filename order before the backend serves requests. No `0157` migration is introduced. Normal startup applies pending migrations. No new environment variables or release version are introduced; remote deletion uses the provider's existing write permissions.

Upgrade readbacks are bounded background observations, not a mailbox reset or a mass mark-read operation. Existing changed-at rows and unresolved flag evidence are compared with current provider state, protecting newer local work. Provider outages defer recovery; large mailboxes can take multiple batches. Do not reset cursors or clear unread counters to accelerate it.

Regression suites use real PostgreSQL transactions, separate worker processes, token-refresh leases, generation/identity races, mixed bulk outcomes, old IMAP UIDs and canonical alias visibility. Collection cases cover incomplete/forbidden discovery, changed credentials, late pages, uncertain deletion and recovery after local cleanup failure; DAV fixtures use localhost HTTP servers. Browser tests cover status readback, confirmation, protected resources and pending-operation recovery across navigation on desktop/mobile. These fixtures do not contact users' providers or send real mail.

## Sender addresses and automatic From selection (#9)

In Settings → Accounts → the account menu → Aliases, the Sender addresses view always includes the primary mailbox address. It cannot be deleted from this view. The radio buttons select exactly one default sender for new messages, independently for each account. Existing aliases keep their display name, Reply-To and signature settings, and can still be edited or removed.

New messages and forwards start with the selected default. The From menu still permits an explicit primary address or another configured alias. The default is a compose-time preference, not an instruction to rewrite an already open message: changing settings or refreshing the account list does not replace a manual selection or a saved draft identity.

Replies and Reply All first select a configured alias from ordered delivery metadata, then match To and Cc identities. A primary mailbox address in delivery metadata is considered only after those matches: forwarded mail can contain both the final primary destination and an originally contacted alias, and the latter must not be hidden. The primary address participates in visible recipient matching, so a Cc alias does not override a primary To match. The original From remains a final fallback for outgoing conversations. Alias creation order no longer outranks the recipient fields. Only the account's primary and configured aliases can be selected. Unconfigured catch-all or BCC delivery metadata does not grant send-as permission. Reply All continues excluding the user's own recipient identities.

Stored recipient objects may expose both `email` and `address`. Sender matching and Reply All self-exclusion normalize `email` first, then fall back to `address` only when the first value is unusable. A valid `email` keeps precedence. This also prevents sending a Reply All copy back to a catch-all address whose metadata has a blank `email`; it does not authorize that address as a sender.

Removing the default alias resets the account preference to primary. A new message whose configured default is unavailable also falls back to primary. In contrast, a saved draft or an already explicit sender selection referencing a removed alias is rejected by the existing send/draft API with HTTP 409 until the user chooses an available sender. This avoids silently exposing another address.

The same account preference and composer apply to IMAP/SMTP, Gmail API and Microsoft Graph. The provider must independently permit sending as the selected alias; Inboxora does not provision provider aliases or change provider permissions. Existing send/draft callers that omit an alias continue to select the primary identity. `PUT /api/accounts/:id/default-sender` accepts `{ "aliasId": "<owned alias UUID>" }` or `{ "aliasId": null }` and returns the persisted account/default selection.

## Default CC and BCC recipients (#6)

Account general settings now include **Default CC recipients** and **Default BCC recipients**, directly below the signature editor in the same General tab. This placement applies to IMAP/SMTP, Gmail API and Microsoft Graph accounts; saved values and recipient behavior are unchanged. Enter bare email addresses separated by commas or semicolons. The lists are saved on the server, separately for every account, and are shared by that account's primary address and all its aliases. This makes the same preferences available in web, desktop and Android clients. Empty lists disable the feature; no provider permission or environment setting is added.

New messages, replies, Reply All and forwards include these recipients as visible, removable chips. Existing message recipients take precedence over automatic additions. Matching ignores address case and display labels; an address configured in both default lists is added only as BCC to avoid exposing a blind recipient. The backend validates each submitted list before saving: at most 50 bare addresses per field, at most 254 characters per address, and no header/control characters, display names or groups.

Changing From to another account removes only untouched automatically added recipients from the previous account, preserves manual recipients, and adds the new account's defaults without duplication. Changing aliases within the same account or refreshing account data does not reset recipient edits or restore removed defaults. Reopening an existing saved draft preserves its saved recipients rather than adding the current defaults again. A subsequent deliberate switch to another account applies that new account's defaults; saved recipients are treated as explicit recipients.

While a send request is pending, sender selection, recipient inputs, chip editing/removal and reply-mode changes are disabled. This prevents a delayed response from overwriting recipient edits made after submission. These controls become editable again after a failure or partial-delivery response.

After confirmed partial delivery, the retained composer keeps only the rejected recipients in their original To/CC/BCC roles and disables automatic recipient changes for the rest of that editing session. Changing accounts, aliases or Reply/Reply All cannot replace a rejected recipient, re-add an already accepted address, or add another account's defaults. Recipients can still be edited explicitly before retrying. This does not change unknown-delivery recovery or the backend idempotency protocol.

Compose actions and mailto links invoked during startup wait for the initial account load before opening the editor, so sender and recipient defaults are seeded from the server preferences rather than an empty account list. Subsequent account refreshes do not remount the composer or reset edits.

Long recipient lists have a bounded scroll area on desktop/landscape layouts, keeping the editor and sending controls reachable even with both default lists filled.

Defaults are a composer preference, not a sending rule. SMTP, Gmail API and Microsoft Graph receive the visible recipient fields through the existing sending pipeline. No server-side send, retry or draft operation silently inserts CC/BCC, and API callers without the updated composer retain their existing behavior. This feature does not implement conditional mail rules or independent recipient defaults for individual aliases.

## Send menu, Undo Send, Schedule Send and mail merge

These are separate actions backed by one durable server-side queue. In personal mail settings, **Undo Send** offers **0, 15, 30 and 60 seconds** in the same styled control as Mail sync frequency. Existing whole-second values from 1 through 59 remain valid server preferences until the user chooses one of those four options; the setting shows the current delay separately with no preset selected. It does not silently change delivery timing. Zero, the upgrade default, keeps immediate sending. Preferences are stored on the server and shared across clients; the composer waits for them to load instead of accidentally bypassing an enabled delay during startup. After sending with a nonzero delay, a countdown and Undo action remain available outside the composer. Refreshing or reopening the client reconstructs pending Undo actions from the server queue.

The main **Send** button retains the usual send and keyboard shortcut behavior. Its adjacent up chevron opens a keyboard-accessible menu with **Schedule send** and **Send mail merge**. The menu opens above the composer footer on desktop and remains within the screen on mobile. Schedule send and Reschedule use Inboxora dialog and form styles in both themes. Choose a date, hour and minute; the browser’s time zone is automatic, with a short localized preview and no editable IANA field. Nonexistent spring-forward times and ambiguous repeated autumn times are rejected, not silently adjusted. Choose an unambiguous local time instead. Past instants, including earlier times today and a deadline that expires while the form is open, are rejected. The backend rechecks deadlines independently of the device clock before accepting a newly scheduled write. The server stores an absolute UTC instant and the display zone. Reopening in another device zone changes only presentation, never the saved instant; an unchanged confirmation also preserves seconds and the original side of a daylight-saving overlap.

**Send mail merge** opens an Inboxora dialog showing the unique recipient count and explaining that other recipients will not be disclosed, with Cancel and Send mail merge buttons instead of a browser confirmation. It creates one separate queued message for each unique address across To, Cc and Bcc, including addresses entered more than once. Each transport submission has that address alone in To, with empty Cc and Bcc. Subject, content, signature, attachments and selected sender are preserved. Forwarded attachment bytes and the signature are materialized once, then every recipient is independently validated with that frozen content and sender identity. Preparation and batch snapshot writes complete before the Undo Send timer begins; a zero-second preference makes the queued messages due immediately. The backend enqueues the batch atomically, within the existing 100-active-entry limit, and a stable request key lets a lost acknowledgement replay the original batch rather than enqueue another copy. Each recipient has an independent queue entry and delivery outcome. Compose keyboard shortcuts are held while a send warning or scheduling picker is open, so warning confirmation keeps the selected action. A message already open from the Scheduled view cannot be converted to a fresh merge; send, save and reschedule it through its existing entry instead. The queue cannot recall a provider submission, and uncertain outcomes still require deliberate review rather than automatic retry.

Deleting the sending account removes its remaining queue entries by the existing account cascade. A retained batch receipt may then list fewer item summaries than its original recipient count; it never re-enqueues the deleted items. Mail merge has no template fields or per-recipient personalization.

Open **Scheduled**, between All inboxes and Calendar in the main navigation, to see pending, paused, preparing, sending, sent, failed, partial, uncertain and dismissed entries. The list, resizable reading pane, message cards, body renderer and attachment controls use the same presentation as inbox folders. Mobile and compact windows keep list/detail steps with Back, matching the inbox layout. Selecting a row is read-only and never pauses delivery. When Edit opens a reply, delayed editor initialization preserves a subject or recipient field already selected by the user instead of moving subsequent typing into the body. The sanitized preview blocks external images, shows headers and attachments, and resolves available reply context by owned message identifiers. Missing source messages do not block the queued preview. Sent previews use a uniquely identified Sent copy when available, not another full message archive.

Queued is not the same as sent. Undo or Edit first atomically pauses the queued record, then restores its recipients, selected sender, body format, signature, reply context and attachment bytes. Passing the original deadline, saving, closing the editor or restarting the backend does not resume it. Choose Send or Schedule send explicitly when finished. Paused autosaves replace that same record without sending it, creating another send-capable draft, or blocking typing. Edits made while an autosave is in flight remain dirty. A lost acknowledgement is reconciled by replaying the exact prior snapshot before submitting a newer revision; an explicit Save then persists the latest local edits at the acknowledged revision, while conflicts or session changes stop that continuation. Explicit saves and sends keep their stronger frozen-request protection. Send from a paused editor resumes the same record using the current Undo Send preference; Schedule Send replaces its due time. Reschedule without editing does not refetch attachments. Cancel discards the stored queue payload before submission and removes the entry immediately, including when the following refresh fails. The cancellation receipt stays in storage to prevent duplicate sends. For an uncertain outcome, the separate **Dismiss** action requires confirmation, purges the queued body/attachments and provider-result recipients, and frees an active queue slot. It does not recall or retry a message that may already have been delivered or may still be in flight. Dismissed receipts are never rearmed by later recovery. Editing and cancellation are refused once a worker has claimed submission, and the view refreshes rather than claiming a delivery was recalled.

The backend must remain running for delivery; the browser, desktop application or Android client may be closed. PostgreSQL coordinates simultaneous workers. Uploaded and forwarded attachments are copied before enqueue acknowledgement, subject to the sending account's normal byte limits and a combined limit of 100 files for queued messages. A user may retain at most 100 active queue entries. Account ownership and the selected sender are checked before preparing and again when sending. Removing the account removes its queue entries; changing/removing a selected sender can leave the message failed for explicit correction instead of silently substituting another address. Default CC/BCC recipients remain visible composer choices and are never inserted by a worker.

### Delivery and recovery safeguards

Enqueue requests have stable idempotency keys. Repeating the same request after a lost response reads the existing receipt, including after cancellation or delivery; changing its content under the same key is rejected. Paused saves and sends use optimistic revisions and an edit fingerprint, so repeated acknowledgements do not create another queued copy and competing editors cannot silently overwrite one another.

A graceful shutdown that reaches the final delivery gate before transport submission returns the owned claim to pending with a fresh revision. The send service provides an internal proof of non-submission, rather than trusting an error-code string. If the backend stops while only preparing a message, the expired claim can be recovered with a new revision and a fence that blocks the old worker from dispatching. If provider submission may already have begun, the message becomes **Uncertain** and is **not automatically sent again**. A durably recorded delivery receipt can resolve that state without a provider send call. Queue receipt keys use the worker-only `scheduled:` namespace; the public Send endpoint rejects that prefix before accessing delivery state, preventing an unrelated same-user send from manufacturing a queue recovery receipt. Confirmed partial deliveries preserve only the definitely rejected addresses in their original To/CC/BCC roles; already accepted recipients and automatic defaults are not reintroduced into the recovery composer. Incomplete or contradictory recipient evidence stays uncertain. Check the provider's Sent folder before manually composing a new copy of an uncertain message.

Successful sends and cancellations clear the queued body and attachment payload. Explicit dismissal of an uncertain entry also clears its stored provider result. Durable receipt identifiers remain for duplicate protection. Failed, paused and partial payloads remain until resolved or explicitly cancelled where safe; uncertain payloads can instead be dismissed without claiming recall; they are private to the owning user and removed with the account/user. The list endpoint returns metadata only, never attachment bytes or BCC recipient lists. Queued attachments use an owner- and revision-checked download endpoint, without pausing or rescheduling the message. Dangerous files use the normal download confirmation; downloading a queued attachment never invokes an inbox mutation.

Cancelled entries are hidden immediately. Dismissed uncertain outcomes retain their seven-day history window; dismissing is not cancellation or recall. Unseen Sent results have no seven-day cutoff and are paginated. A visible Sent badge in the active queue records an idempotent, owner-scoped acknowledgement without changing delivery revisions or receipts. The entry stays throughout that visit, including refreshes and internal dialogs, and is hidden on the next visit or full reload. Background tabs, polling and offscreen rows do not count. Failed writes are retried and may show the result again later. Concurrent tabs retain their current visit; later visits on another device honor the saved acknowledgement. Leaving the view does not stop global Undo or delivery. This never deletes mail from Sent. This is not a recall mechanism for mail already accepted by a provider.

### API and acceptance checks

Authenticated routes live under `/api/mail/scheduled`: GET lists metadata, with `?page=1` and an opaque `cursor` for complete history; `GET /:id` reads a preview without pausing; `POST /:id/seen` acknowledges only a sent result; POST enqueues with `X-Idempotency-Key`; `POST /:id/edit` pauses a revision and returns its frozen message; `PUT /:id` saves/requeues the paused revision; `PATCH /:id` changes its future instant; `POST /:id/cancel` cancels before claiming; `POST /:id/dismiss` acknowledges only an uncertain outcome without recall or retry. The PUT flags `keepEditing: true` and `sendNow: true` are mutually exclusive. The first preserves the paused state and existing due time; the second queues the same record using the saved Undo delay. Without either flag, PUT requires an explicit future UTC ISO timestamp and a valid IANA display zone. Delivery mutations are owner-scoped and revision-checked. Viewed-status acknowledgements check owner and sent state separately, without incrementing delivery revisions.

The mail-merge HTTP endpoint uses the same attachment-aware JSON request window as normal and scheduled sending, rather than the generic 1 MB API limit. The shared preparation pipeline still enforces account/provider message and attachment limits. A live authenticated API regression exercises a request above 1 MB without enqueuing or sending mail.

Authenticated `POST /api/mail/merge` accepts `{ "message": ... }` and a stable `X-Idempotency-Key`. Its receipt identifies the batch and its per-recipient queue entries. Reusing that key with changed content fails; the original receipt remains replayable after entries are sent or cancelled. No provider bulk-send permission or new environment setting is required.

For acceptance testing, use a mailbox and recipients you control. Try delays of 0 and 60 seconds, Undo near the deadline, reloading while a countdown is visible, and a scheduled message with the client closed. Pause a message, change its body/attachments and sender, close/reopen it, then reschedule or cancel. Test both desktop and mobile. Confirm the exact To/CC/BCC fields, a time-zone change and a daylight-saving gap/repeated hour. For mail merge, repeat an address across To/Cc/Bcc and verify that each unique recipient gets one private message with no Cc or Bcc; retry the same request key and confirm no extra entries appear. A network retry must not produce a second queue entry. Restart/partial-delivery regression tests use isolated PostgreSQL and fake transports; automated tests do not send real user mail.

## Administrator upgrade requirements

Back up the database first. Apply the normal migration chain through **`0155_scheduled_mail_seen.sql`**, after `0149_body_cache_retention.sql` and `0150_account_default_sender.sql`, **before the updated backend handles requests**. Normal backend startup runs pending migrations. Migration `0150_account_default_sender.sql` adds `email_accounts.default_alias_id`, a same-account composite foreign key and an index. Existing accounts retain their primary default. Deleting a selected alias clears only the optional default reference, not the mailbox. Previously published migrations are unchanged. Migration `0151_account_default_recipients.sql` then adds bounded, non-null `default_cc` and `default_bcc` text arrays with empty defaults. Existing accounts do not gain any automatic recipients on upgrade. Migration `0152_scheduled_mail.sql` follows `0151_account_default_recipients.sql` and adds the durable message queue, revision/idempotency constraints and due/lease indexes. Migration `0153_scheduled_mail_dismissal.sql` then adds the explicit terminal dismissed state. Migration `0154_mail_merge_batches.sql` follows `0153` and adds durable batch receipts for atomic enqueue and lost-ack replay. Migration `0155_scheduled_mail_seen.sql` follows `0154` and adds `sent_seen_at`, small `sent_metadata` headers and an unseen-Sent index. Existing sent rows start unseen; no body or attachment is copied back into the queue. Earlier migrations are unchanged. Replace the backend and frontend together so the settings, queue and composer agree.

The column-specific `ON DELETE SET NULL` requires PostgreSQL 15 or later; the supported Compose/CI PostgreSQL 16 configuration is covered by the database tests. No new environment variables, provider scopes or user data backfill are needed.

## Validation and acceptance

Queue regressions cover overnight delivery, first visible Sent, retention through refreshes, leave/revisit, offscreen rows, hidden documents, status changes, concurrent tabs, failed/late acknowledgements, changed sessions and old paginated results. PostgreSQL cases check ownership, unchanged delivery receipts, read-only previews, reply identity through editing and Sent-copy lookup. Browser captures cover light/dark desktop, portrait and landscape queue and dialog layouts. Automated delivery tests use controlled transports.

The PostgreSQL CardDAV contact-preservation fixture also covers privilege discovery at its mocked network boundary. Unexpected DNS/HTTP access fails the fixture immediately; contact-content and DAV-version assertions are unchanged. This fixes a network-dependent CI timeout, not production CardDAV behavior, and requires no migration or configuration change.

Regression coverage includes per-account defaults, primary/manual/saved-draft preservation, delivery/To/Cc precedence, malformed address metadata, account ownership checks and deletion races. A fresh production migration chain and four real PostgreSQL constraint/cascade tests pass on PostgreSQL 16. Browser regressions cover protected primary controls, persistence, new-message defaults and manual selection, default deletion, failed saves and stale settings responses on desktop and mobile.

For acceptance testing, select an alias as default, start a new message, manually switch From, reply to messages addressed to both the primary address and a different alias, reopen a saved draft, and remove the selected default alias. Test sending only with provider-authorized identities. The development image should be published from the exact reviewed SHA after CodeRabbit and required CI checks pass; main remains unmerged until acceptance.

CC/BCC regression coverage additionally exercises API ownership and atomic validation, 22 PostgreSQL migration/constraint cases, automatic-recipient ownership, uncommitted input, partial-send retry preservation, settings persistence and failures, exact send payloads, blank-message autosave and saved-draft reopening. Desktop and mobile browser cases also protect the existing sender-alias behavior.

Mail merge regression coverage checks deduplication and address validation, one-recipient queued payloads with empty Cc/Bcc, one-time forwarded attachment reads, sender changes during preparation, atomic rollback after preparation or insertion failure, zero-second due times, concurrent lost-ack replay and receipt replay after account deletion. Fake SMTP transport tests inspect each rendered message and envelope without sending mail. Browser cases cover menu focus, Escape, viewport placement, warning shortcuts, confirmation, retry keys and the four Undo Send choices, including a legacy intermediate value. The PostgreSQL cases use an isolated temporary schema and fake send preparation; no automated test sends real mail.

For CC/BCC acceptance testing, save multiple defaults on two accounts, compose using primary and alias identities, remove a default, add manual recipients, switch accounts, and save/reopen a draft. Confirm the exact visible To/CC/BCC fields before sending a test message. Also test Reply/Reply All transitions and the mobile composer.


## Provider reconciliation follow-up

Apply `0161_collection_rediscovery.sql` after 0160 and before deploying this backend. It records discovery provenance for address-book retirement and preserves calendar enablement through a disappearing/reappearing subscription. A later complete, authorized discovery restores only an older discovery absence; confirmed provider deletions remain fenced. Restored calendars start a fresh event baseline. Legacy address-book tombstones without provenance remain conservative rather than guessing that a deletion was only a discovery absence.

Gmail readbacks accept an omitted empty label list but reject malformed identities or label values. Graph visibility recovery backs off failed or malformed candidates while continuing other candidates and normal folder synchronization; authorization errors still stop the account, and throttling stops the recovery slice. Definitive DAV deletion responses must retain the requested collection identity. One failed optional visibility check is backed off without starving other messages or invalidating a completed mail delta. Ready frontend read intents use batches of at most 500 IDs with at most four concurrent requests; provider collection capability checks use four ordered workers.

Conversation-only detail reads use the same session and physical-flag readback guards as native threads, including initial loads and live refreshes. A stale response cannot overwrite a later read/star click; a post-settlement readback can still correct an unknown outcome.

The reader keeps the selected physical copy and its read state even when several copies share a logical message. Frame height measurements preserve outer layout so repeated measurements cannot clamp an already-scrolled reader. Tests cover mixed read outcomes, physical duplicates, same-sync CardDAV contact survival, subscription restoration, empty Gmail labels, invalid visibility candidates, and graceful migration-fixture shutdown. No additional provider scopes or environment settings are needed for this follow-up.


## Gmail history recovery and mailbox isolation

A Gmail history entry or message listing can refer to a thread that has since been deleted. A 404 from that exact thread read now skips the unavailable thread instead of aborting the mailbox on every retry. A 404 from the history endpoint still follows the separate expired-cursor baseline recovery. Authentication, throttling and server failures are not treated as empty threads. Local messages are removed only with explicit history deletion evidence or a completed account-wide baseline, and history deletion transactions are fenced to their worker generation.

Gmail folder totals and unread badges are recomputed from visible physical rows and label memberships after sync/discovery. Missing count fields in a label listing no longer reset an existing badge to zero. Removing a label preserves a now-labelless message in the virtual Archive instead of deleting its physical row. Inboxora's inbox badge counts inbox messages; unread messages archived or filed outside the inbox are not silently added to that badge.

An explicit disabled, removed or unowned account request returns no mail; it never falls back to the unified inbox. Browser list/search requests and delayed rollback paths also retain their account and navigation boundaries. A response that contains another account's rows is rejected before caching or flag readback. A late reader resolution cannot reopen an older selection.

Native-account diagnostics show the mail pipeline's timestamp and status from the same snapshot as the detailed mail section. Opening that tab obtains current state; a recent successful calendar/contact sync or active push subscription does not conceal a failed mail run. No new migration, permission or environment setting is required beyond the chain through 0161 already documented above. Update both images; normal synchronization resumes from its stored checkpoint, without deleting the account, resetting cursors or marking messages read in bulk.

Regressions use synthetic provider responses and isolated PostgreSQL. They reproduce a deleted thread blocking six unread messages, a disappearing thread during baseline import, stale-worker deletion, missing label counts, an unavailable account returning unrelated mail, delayed cross-account UI responses and coherent diagnostics. They do not access real Gmail accounts or prove the historical path of any specific production message.


## Gmail list latency and reply addressing

Folder membership is now evaluated as an account-scoped set instead of a correlated label lookup for each message. This removes the inflated planner costs that caused expensive PostgreSQL JIT compilation in Gmail and unified inbox lists. Lists, total counts, unread badges and category counts retain the same physical-copy, label, archive and account boundaries. Flat lists also select the requested page before loading full metadata and contact photos. No database-wide JIT setting, index or migration is changed. A PostgreSQL regression covers 40,000 multi-labelled messages and guards both results and query plans, including a low-memory join plan.

Reply-To is retained when native thread messages are adapted to the Conversation Reader. Reply and Reply All accept both `email` and `address` fields from providers, with a non-empty email field taking precedence. MIME rendering passes structured addresses rather than reparsing display names; commas or address-like text in a name cannot replace the intended Gmail recipient. SMTP envelope recipients and BCC privacy remain unchanged.

Synthetic tests cover the reader-to-composer recipient and the actual base64url MIME passed by the send pipeline to a mocked Gmail boundary, including a fresh Message-ID and the selected parent headers. An accepted send or a provider Sent copy is not a delivery receipt from the destination server. These fixes do not establish why a particular historical message was absent from both Inboxora and the destination webmail. Investigate that message using its actual To/Reply-To/Message-ID and any delivery-status notification, without automatically resending it.

Update both dev images together. No additional migration, provider permission or environment setting is required beyond the earlier chain through 0161.
