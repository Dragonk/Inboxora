# Changelog

All notable changes to Inboxora are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For the narrative version — what the release means, what to expect when upgrading, and the known
limitations — read the matching page in the Wiki: [Release notes 4.1.0](wiki/Release-notes-4.1.0.md),
[Release notes 4.0.4](wiki/Release-notes-4.0.4.md),
[Release notes 4.0.3](wiki/Release-notes-4.0.3.md),
[Release notes 4.0.2](wiki/Release-notes-4.0.2.md),
[Release notes 4.0.1](wiki/Release-notes-4.0.1.md) and [Release notes 4.0.0](wiki/Release-notes-4.0.0.md).

## How entries are kept

Work in progress accumulates under the section for the version it is intended for — today
**`[4.1.0]`, which is prepared on `dev` and is not released yet** — with one heading per category in
Keep a Changelog order (**Added → Changed → Deprecated → Removed → Fixed → Security**). A change is
recorded in the same commit that makes it, not gathered afterwards from the commit log, which reliably
loses the "why" and keeps only the "what". `[Unreleased]` is for work whose version has not been
chosen, and it is empty while a version is in preparation.

**A section is dated only once the version is actually released**, which happens when `dev` is merged
to `main` — until then it carries no date, the way `[3.4.0]` does. The matching
`wiki/Release-notes-<x.y.z>.md` is written alongside it and states its own status honestly: prepared
on `dev`, released, or superseded. The release notes are the narrative — user and operator impact,
migration and configuration requirements, the **known safe limitations**, and what was verified
(including anything left **NOT RUN**). A version is never inferred from the size of the section, and a
release is never claimed before it has happened.

## [Unreleased]

Nothing is being prepared beyond 4.1.0. Work whose version has not been chosen accumulates here.

## [4.1.0]

### Added
- **A legacy Gmail or Outlook account can now actually migrate.** The recommendation and the cutover were
  answering the same question with different rules: the Google recommendation recognised a Gmail mailbox by
  its IMAP host, while the Gmail cutover accepted only `oauth_provider = 'google'`. A real 4.0.4 account —
  added over IMAP with an app password, so `oauth_provider` is NULL — was therefore offered "Migrate to the
  Google API" and then answered `ACCOUNT_MIGRATION_NOT_APPLICABLE`. The same gap hid the Microsoft migration
  entirely for an Outlook account with `imap_host = outlook.office365.com` and no recorded provider. One
  shared classifier now answers the question for the recommendation, both cutovers, the migrate route and the
  interface, using the stored provider, the IMAP hosts Inboxora's own presets shipped, and an existing active
  provider connection whose verified identity is that mailbox (which is what recognises a Google Workspace
  address on a custom domain). A classification only says "this account is a candidate": the switch still
  requires an active connection of that provider, owned by the user, with a matching verified identity and the
  scopes the transport needs, so no host name can move a mailbox on its own.
- **Integrations no longer starts an authorization.** The Graph connector, its device-code variant, the
  Google calendar/contacts connects, the per-user "connected accounts" list with its disconnect action and the
  per-connection push switch are gone from Settings → Integrations. Each of them belongs to one mailbox and is
  now on that account's card, next to the transport, the migration and the push state it affects. What remains
  in Integrations is the installation: client id, tenant, secret, redirect URI, the readiness of each method,
  the scopes and capabilities, the global webhook/Pub-Sub configuration, the configuration test and the
  aggregate diagnostics.
- **The account card is the account's provider centre.** Each mailbox now shows its own provider services:
  the mail transport it uses (Microsoft Graph, Gmail API or IMAP/SMTP) and the migration action when one
  applies, whether its calendar and contacts are connected with the number of pulled collections, and the
  instant-synchronisation state of mail, calendar and contacts. `GET /api/accounts/:id/provider-features`
  answers it, resolving a connection by the verified identity (`provider_user_id` = the account's address)
  rather than by creation order. Connecting a calendar or contacts grant starts the provider's flow with the
  purpose that matches the service, so a user may keep mail on IMAP and connect only the calendar, or only
  contacts.
- **Google Calendar, Google Contacts, Microsoft Calendar and Microsoft Contacts keep their independent
  grants**, unchanged: `mail_migration`, `calendar_enable` and `contacts_enable` stay separate purposes, and
  nothing about one implies another.

- **Settings → Integrations configures provider applications; Settings → Accounts connects mailboxes.** The
  provider cards were starting a mailbox authorization ("Connect Microsoft account", the Microsoft API
  device-code connect), which mixed an administrator's infrastructure job with a user's own account. Those
  actions are gone from Integrations, which keeps what belongs to it — client id, tenant, secret, redirect
  URI, browser/device-code readiness, scopes and capabilities, push/webhook/Pub-Sub configuration and the
  configuration test — and now points to Accounts for mailboxes.
- **"Add account" starts with the kind of mailbox.** The account screen offers **Microsoft**
  (Outlook.com / Hotmail / Microsoft 365), **Google** (Gmail / Google Workspace) and **IMAP/SMTP** (another
  provider or a manual setup); only the last opens the existing connection form, where the Gmail preset is
  labelled as the app-password path. A provider that is not configured says so, with a link to Integrations for
  an administrator, instead of failing after a sign-in attempt; client ids, secrets, tenants and redirect URIs
  are never shown to a user.
- **A mailbox added through its provider becomes a native account.** Signing in with Microsoft or Google
  creates the account directly on **Microsoft Graph** or the **Gmail API** — `mail_transport` and `protocol`
  set, the provider connection bound, the address and mailbox id taken from the provider rather than a typed
  field, no IMAP/SMTP configuration, and folder/label discovery started. Adding an account no longer means
  "create an IMAP account and migrate it afterwards"; the cutover stays the tool for accounts that already
  exist.
- **An existing mailbox is never duplicated.** Adding a mailbox that is already present over IMAP/SMTP answers
  with the account that exists and the migration for that provider (Microsoft Graph, or the Gmail API) instead
  of creating a second row for the same address.

- **Push-assisted synchronisation for the native providers.** A mailbox no longer waits for the next
  scheduled pass to notice a change: Microsoft Graph change notifications (messages, events and personal
  contacts), the Gmail API `watch` over Cloud Pub/Sub, and Google Calendar push channels deliver a signal, and
  Inboxora turns it into **the sync it already had** — the same delta, history and sync-token cursors, the
  same conversation engine, rules and notification pipeline. Push shortens the delay; it is never a second
  source of truth and never a second synchronisation path.
- **One push subscription model for all three mechanisms**, with the validation secret stored only as a hash,
  per-scope uniqueness so a recreate cannot double the notification volume, expiry tracking, and a renewal
  sweep that renews well before a subscription lapses (with jitter and backoff, and no renewal at all for a
  provider that was switched off).
- **Instant synchronization in the provider cards.** Each connection shows whether push is active (with its
  expiry and last event), whether the installation is falling back to polling, whether a public HTTPS URL is
  missing, or whether the last renewal failed — and can be turned on or off per connection. Turning it on
  registers exactly the resources that connection pulled.

- **An existing Google mailbox can move to the Gmail API in place.** A Google account that has been reading
  its mail over IMAP/SMTP with an app password now has a one-click migration to the native Gmail transport:
  the account keeps its id and **all** of its local data (messages, folders, conversations, aliases,
  signatures, rules, drafts, plugins and preferences), exactly one account remains for that mailbox, the
  provider connection and grant are recorded on it, and a retry after a failure is idempotent. The switch is
  committed in a single transaction, so an interruption leaves either the whole switch or none of it — never a
  half-migrated account. This is the same guarantee the Microsoft Graph cutover gives, applied to Gmail.
- **The recommendation card can perform the migration it recommends.** "Migrate to the Google API"
  authorizes Gmail when the mailbox has no Gmail-scoped grant yet, waits for that authorization, then
  migrates the account; on success the account state is refreshed and the recommendation disappears, and on
  failure the account stays on IMAP/SMTP and the recommendation stays visible. "Ignore" hides it for the
  session and "Do not show again" stores the preference — a suppression is never a side effect of a failed or
  successful migration.

- **One occurrence, this-and-following, or the whole series — in every writable calendar.** A recurring
  event can now be changed or cancelled for **just the occurrence you picked**, for **that occurrence and
  every later one**, or for the entire series, in a local calendar, a Google calendar, a Microsoft Graph
  calendar and a write-enabled external CalDAV collection. Google and Microsoft previously answered `501` for
  anything but the whole series: a series' unmodified occurrences have no id of their own in an ordinary
  listing, so the occurrence is resolved against the provider's own **instance listing** (Google's
  `instances`, Graph's `/instances`, matched on the occurrence's original start) before anything is written.
  "This and following" is implemented the way the providers do it — the series is truncated before the
  occurrence (`UNTIL` for Google, `endDate` for Graph, the stored rule for CalDAV) and, for an edit, the
  remainder becomes a new series carrying the same attendees and the client's values. The whole series keeps
  working as before.
- **The event editor offers the same three scopes.** Editing a recurring event now asks whether the change
  applies to *this occurrence*, *this and every following one*, or the *whole series* — the delete dialog
  already asked, and the edit dialog previously offered only the first and the last, so the middle one the
  server supports could not be requested from the interface.
- **Invited series can be changed per occurrence.** Editing or cancelling one occurrence of a series you
  organised, or the rest of it, now sends the matching iTIP message — a `REQUEST` or `CANCEL` carrying
  `RECURRENCE-ID` for a single occurrence, and an updated rule for "this and following" — with the sequence
  advanced, instead of refusing the change. Previously such a mutation was refused outright. A delivery
  failure is reported without undoing the change, and no duplicate invitation is sent when the operation was
  performed at Google or Microsoft, which notify attendees themselves.
- **A write-enabled external CalDAV or CardDAV collection is editable from Inboxora's own interface.**
  Creating, editing and deleting a calendar event or a contact in such a collection now goes to the source
  server through the same write-back client a DAV client's request uses, including recurring series and the
  three occurrence scopes. Before this, only a request arriving over DAV reached the source: the web editor
  offered an edit that the server then refused. The entity-tag you loaded is forwarded as the precondition, so
  an object changed at the source answers `409`/`412` instead of being overwritten.


- **Native Microsoft Graph mail.** A Microsoft account can run its whole mailbox over Graph instead of
  IMAP/SMTP: folder discovery with canonical paths for Outlook's well-known folders, message metadata with a
  per-folder delta cursor and a `410` rebuild that reconciles rather than losing rows, read/star flags through
  the shared mutation journal, message bodies and attachments read on demand (inline images included), delete,
  move and archive, spam/ham marking, snooze in both directions, bulk delete, mark-all-read, source headers,
  the attachment ZIP, drafts (save, reopen, replace in place, delete at the provider), and sending — with
  provider-side search that asks Graph's own index for anything the local projection has not pulled. The
  conversation engine is fed from Graph, and the IMAP loops, health checks and the automated rule forwarder
  all follow the account's own transport, so a native account never opens an IMAP or SMTP connection.
- **An existing Microsoft account moves to Graph in place.** `POST /api/accounts/:id/migrate` switches the
  transport on the **same** `email_accounts.id`: no second account, no duplicate mail, and every local message,
  folder, draft, alias, signature, rule and conversation is left exactly as it was. The switch is one atomic
  update under a row lock, is idempotent on retry, records `authorization_required` or
  `admin_configuration_required` instead of failing when the grant or configuration is missing, refuses an
  account/connection mismatch by name, and has **no fallback** to Microsoft IMAP/SMTP afterwards.
- **Microsoft Graph calendars and contacts.** Calendar discovery and delta sync with structured recurrence
  rendered to `RRULE` and a generated `VTIMEZONE`, plus creating, editing and deleting calendar events and
  contacts through the provider journal — the provider is written first, the local copy changes only on
  confirmation, and the provider's own attendee notifications are not duplicated by Inboxora.
- **Microsoft authorization by device code.** For tenants and deployments where a client secret or a redirect
  URI is not wanted: the device-code flow authorizes a Graph connection as a public client, holding the device
  code encrypted on the flow row together with the provider's polling interval, so a restart does not strand a
  pending authorization.
- **The Gmail API as an optional mail transport.** Label discovery and projection onto the local folder model,
  message and thread ingest on a resumable mailbox history cursor, bodies and attachments read on demand,
  message mutations (flags, move, archive, trash, spam/ham, snooze, permanent delete, mark-all-read) through
  the journal, drafts, and sending — each dispatched on the account's transport, so a Gmail message is never
  read over IMAP. **Google mail keeps working over IMAP/SMTP with an app password**; the API is recommended,
  never forced.
- **Google Calendar and Google Contacts.** Discovery, per-collection switches, delta sync with a rebuild that
  reconciles, and creating, editing and deleting events and contacts through the same provider journal, with
  the provider's identity linked so the next sync updates rather than duplicates.
- **A migration recommendation for Google mailboxes.** `GET /api/integrations/notices` lists the
  recommendation for the caller's own Google mailboxes still on IMAP/SMTP — only while the provider layer, the
  method and an OAuth client are configured — and the accounts settings show it per mailbox with *Ignore*
  (this session) and *do not show again* (durable, per user and per mailbox). The Microsoft requirement notice
  cannot be suppressed.
- **Write-back for external CalDAV and CardDAV sources.** A `PUT` or `DELETE` on a calendar or address book
  imported from an external DAV server is forwarded to that server through the provider journal, keeping the
  client's `If-Match`/`If-None-Match` precondition, answering `412` on a changed object, parking an ambiguous
  source answer instead of retrying it, and updating the local copy only after the source confirms. Every
  imported collection gets the link the write-back switch needs — including collections imported before this
  release, on their next sync.
- **Provider data can be written back per collection.** An imported collection is read-only until write-back
  is enabled for it, and the switch is offered only for a collection the source itself allows to change:
  Microsoft Graph and Google collections over the web interface, external CalDAV/CardDAV collections over DAV,
  and never an ICS subscription.
- **Send and attachment limits that follow the transport.** The composer, the API and the transports share one
  model: the effective limit is `min(installation, provider, operation)`, and each refusal names the dimension
  it hit — one attachment, their total, the inline images the composer creates, the composed RFC-822 message,
  Gmail's raw message, a Graph upload-session file, or the HTTP request body — with the real byte count and
  the limit. A Microsoft Graph account carries a single file up to its own upload-session ceiling through a
  resumable upload (above 3 MB the file stops travelling inline), Gmail is bounded by the raw message it
  accepts, and an SMTP account by the installation's ceiling. `GET /api/mail/send-limits` publishes the
  effective numbers, and the composer refuses a file it already knows cannot be sent without closing or
  clearing the draft.
- **The menu-follows-your-finger mobile drawer gesture**, with a switch beside the navigation-position setting
  and arbitration against scrolling, long-press and row actions.
- **A hardened CalDAV/CardDAV server.** Discovery, strong entity-tags for `If-Match`, per-collection visibility
  and access mode, a per-password ceiling that can only narrow what a collection allows, WebDAV `If`
  handling, `403 DAV:valid-sync-token` on an expired sync token, report dispatch on the XML root element, and
  `DAV:error` bodies on refusals.
- **A database CI job and the browser matrix on the `dev` gate.** The database job applies the whole migration
  chain to an empty database with the application's own runner and then runs the provider, DAV and send
  integration suites; every piping workflow fails on a real pipeline error.

**Migrations `0101`–`0112`, in order and before rollout.** They are additive and no existing row is
rewritten: `0101` provider layer (connections, grants, remote links, collections, journal, notice
preferences), `0102` operation journal and outbox, `0103` authorization flows, `0104` grant refresh lease,
`0105` collection DAV mode, `0106` DAV credential ceiling, `0107` mail-folder collection link, `0108` message
provider identity, `0109` provider-operation payload, `0110` device authorization, `0111` Gmail API
(`messages.provider_labels`), `0112` collection write-back. Apply them **before** rolling out a build that
reads the new columns; a mixed old/new deployment must not run with the new code before the migrations.

### Changed
- **The per-account diagnostics say how each feature is refreshed.** Every feature now reports the
  `syncStateCoverage` its fields were read from (`history`/`messages`, `events`, `personal`) and whether it is a
  `schedulerTarget` — an enabled collection of the right kind linked to a local folder, calendar or address
  book, which is the question the scheduler's own query asks. A feature that is authorized but not a target is
  refreshed by a manual run alone, and saying so turns "last synchronised: never" into an answer. Pinned on
  PostgreSQL, together with the guarantee that the coverage reported is the pipeline's rather than the discovery
  row's.

- **The two provider configuration cards are laid out the same way.** They hold the same two actions, so they
  now sit in the same order in one action row — save, then the configuration test — with the same padding,
  radius, font size and weight, and the result block below the row in both. The Google card had been labelled
  with the Microsoft save key, and the Microsoft card kept its test action outside the row and a guidance line
  inside it; both are corrected, and a contract test keeps the two cards from drifting apart again.

- **A CardDAV contacts source is added from Contacts, where the books it pulls live.** A calendar's sources are
  managed on the calendar screen, and a contacts source belongs in the same place for the same reason: it is a
  source of the feature the user is looking at, not an installation setting. The address-book manager now has a
  **Sources** section that shows the CardDAV connection, lets a server, user and password be entered, and offers
  synchronise and disconnect — with the same strings the settings screen used, so the concept is named
  identically. The pull stays one-way and read-only, and the stored password is never rendered back.

- **Polling remains the safety net.** The provider schedule is unchanged and still refreshes every pulled
  collection; push only makes the common case fast. A missing public URL, a provider outage or a failed
  renewal leaves synchronisation working, and an account is never reported as broken merely because push is
  unavailable.
- **`PROVIDER_SYNC_INTERVAL_MINUTES` stays the fallback cadence.** Push does not lengthen it: the schedule is
  what guarantees self-healing when a notification is missed, so shortening the delay by push never widens
  the window in which a missed change could hide.

- **Microsoft Contacts records what the connection's grant actually permits.** The Graph contacts sync
  recorded every address book as read-only at its source, which made the per-collection write-back switch
  refuse to enable any of them — so the Graph create/update/delete adapters existed and could never be used.
  The sync now reads the grant: `Contacts.ReadWrite` (or a `.Shared`/`.All` variant) records `read_write`, a
  read-only grant records `read_only`, and an existing collection is corrected on the next sync. The user's
  own opt-in stays a separate decision.
- **Recurring → non-recurring reaches the provider, and no longer leaves a stale rule.** A whole-series edit
  that removes the repetition now sends an explicit clear (Graph `recurrence: null`, Google's empty
  `recurrence` list) instead of omitting the field, which had left Google's or Graph's old series running
  while the local copy became a one-off. The web editor's "repeat: none" therefore means the same thing at the
  provider as it does locally.
- **An external collection's write path is one path.** The web interface, the REST API and the DAV server now
  answer whether a collection accepts a write from the same capability model and forward it through the same
  client, so a collection cannot look editable in one place and be refused in another.


- **A collection's write permission now needs both the origin's consent and the user's.** Every REST and DAV
  write guard, the DAV advertised privileges and the interface's editability read one capability model that
  combines the origin adapter, the collection's own access, the user's opt-in and the DAV password's ceiling.
  The interface reads the server's `read_only` instead of re-deriving editability from a calendar's origin.
- **The send path composes the message once.** The route builds the canonical message model, renders it for
  the transport that needs a wire format (SMTP) or hands the model over (Graph, Gmail), and measures the
  artefact it will actually send. The envelope (`to`, `cc`, `bcc`) is explicit rather than derived.
- **`MAIL_MAX_MESSAGE_BYTES` is a fallback, not a universal cap.** It applies to a transport that declares no
  message ceiling of its own (SMTP) and never shrinks a provider that declares a larger one.
  **`MAIL_MAX_ATTACHMENT_BYTES`** is new: the hard installation ceiling on one attachment and on their total,
  applied to every transport, defaulting to the largest file a supported provider carries.
- **Mail flag changes go through the shared provider-mutation journal**, so a native account's flag write is
  claimed durably, retried by the next sync when a transient failure is recoverable, and undone locally when
  the provider permanently refuses it.
- **Provider synchronisation is licensed per collection**, so two workers cannot sync the same collection at
  the same time, and `PROVIDER_INTEGRATIONS_ENABLED=0` disables the whole provider layer at the authorization
  flows and the sync routes.

### Deprecated

None.

### Removed

- **The single global attachment ceiling.** A 25 MB total no longer refuses a Microsoft Graph message that
  Graph carries through its upload session; the limit applied is the sending transport's own.
- **IMAP/SMTP as a fallback for a native account.** Once an account is moved to Graph or the Gmail API, the
  IMAP loops, health checks, rule forwarder and send path no longer open IMAP or SMTP for it.

### Fixed
- **"This and following" no longer restarts the repeat count when the editor sends the rule.** The composer
  copies the series' own recurrence into the editor for a "this and following" change, so the rule that arrives
  with an edit carries the **series'** count, not the remainder's. It was applied verbatim, which restarted the
  series from the split: editing a series of twelve occurrences at the fourth left the remainder repeating twelve
  more times instead of the eight that were left. A supplied count now loses the occurrences the earlier part
  keeps, matching the behaviour when no rule is sent, and a count that cannot be derived is refused before
  anything is written rather than producing a series that disagrees with itself.
- **A connected account whose first synchronisation failed is picked up again instead of staying empty.** The
  schedule selected connections through the collections they already held, so discovery was reachable only from a
  collection that already existed: a connection whose initial run failed — or a process that restarted before it
  finished — had nothing to be found by and was skipped forever, leaving the mailbox, calendar or address book
  empty until the user acted. The target query now also selects active connections that hold **no collection at
  all**, and the run refreshes them through the same mail adapter that discovers before it pulls (labels for
  Gmail, folders for Microsoft), so there is still one discovery path. Holding nothing is the durable retry
  signal — it survives a restart with no extra bookkeeping — and each attempt's outcome is recorded where every
  other run's is, in `sync_states`, so a persistent failure is visible in diagnostics rather than silent. A
  connection whose collections are all disabled or unlinked is still out of the schedule: the user's own choice
  is what made them unusable, and re-running discovery must not overrule it. Calendar and address-book discovery
  stay what they were — started by the user connecting those services — so this does not create collections
  nobody asked for.
- **The Microsoft calendar delta request no longer sends parameters the delta function rejects.** The page request
  combined `events/delta` with `$select` and `$top`. Microsoft documents `$select`, `$expand`, `$filter`,
  `$orderby` and `$search` as unsupported for the delta function (on events and on a calendar view), and pages a
  delta round with `Prefer: odata.maxpagesize` rather than `$top`; the request was one the contract cannot
  answer. It now sends only the documented preference, together with the UTC time-zone preference the instances
  call already uses so an occurrence's identity is compared in one frame. This does **not** yet resolve the
  remaining part of the finding: the item-delta form this projection needs (it returns series masters, where a
  calendar view returns occurrences) is documented as beta-only on the pinned `v1.0` contract, and choosing
  between a beta read and a windowed redesign needs validation against a live tenant rather than a blind switch.
- **A CardDAV pull no longer overwrites contacts that belong to Google or Microsoft.** With duplicate handling set
  to "merge", a card whose email matched a contact in another book was written onto that contact with no check of
  who owned it. A Google or Microsoft contact is synchronized with its provider and this pull has no write-through
  to it, so the change existed only locally and the provider's next sync reverted it — whichever edit came second
  was lost silently. A merge now applies only to a book this pull may write (another DAV book of the same source,
  or one of the user's own local books); a provider-owned duplicate is left untouched and the incoming card is
  created as its own contact, so both copies survive.
- **The address books appear as soon as a CardDAV source is connected.** Connecting pulls the server's address
  books, but the panel that did the connecting never told the screen, so the books the user had just connected
  did not appear until the page was reloaded by hand — which is what made DAV look like an import rather than a
  source. The source now reports connect, synchronise and disconnect, and the contacts screen reloads its books
  and its list in response.
- **A CardDAV pull is applied as one transaction, so a failure can no longer leave a book half-written.** The
  delete of the rows a snapshot no longer lists, the upserts, the merges and the new sync token ran as separate
  statements. The delete has to come first — a uid or email freed this round must not collide with an incoming
  card — but without a transaction it became visible on its own, so a failure halfway through left the address
  book missing contacts until the next successful pass. All four now commit together or not at all.
- **A CardDAV address book no longer reads "never synchronised" and now has a sync action.** The books manager
  knew only about Google and Microsoft: for a book whose source is CardDAV it computed no state and offered no
  action, so a source that had just run still showed "never", and the only way to synchronise it was the separate
  DAV section. The manager now names its sync target from the book's own source, and the contacts page reads the
  DAV source's status so a DAV book reports its real last sync (or the failure code) and can start a sync from
  its own panel. Which source owns a book decides the action, never the provider a book resembles.
- **A Microsoft reply is now created as a reply, not as a new message carrying headers Graph ignores.** Replies
  were staged the same way as any new message, with `In-Reply-To` and `References` put into
  `internetMessageHeaders` — but Graph's JSON contract accepts only custom headers whose name starts with `x-`,
  so those two were never honoured and the message had no threading relationship the provider recognised. A send
  now carries a semantic kind (new/reply/reply-all/forward, derived when the client omits it) and the answered
  message's provider id when it belongs to the same mailbox; the transport stages those with the provider's own
  `createReply`/`createReplyAll`/`createForward` and then patches the draft with the composed content. A reply to
  a message that lives in another mailbox is deliberately not modelled as a provider reply rather than borrowing
  an id from a different mailbox, and it no longer sends headers that would be dropped.
- **A disabled address book is no longer pulled, on a manual run as well as on the schedule.** The calendar half
  of this was fixed earlier; contacts were still synchronised whenever the connection was, so a book the user
  had switched off was written to from a manual "sync contacts" and could be re-created locally. Both contacts
  adapters now check the collection's own `enabled` flag and report `disabled: true` instead of pulling, leaving
  the book and its contents untouched.
- **A calendar-series change validates and builds both writes before the first one.** Splitting a series is two
  remote writes — truncate the master, then create the remainder — and the master used to be truncated before
  the request was even checked for the values it needs, or before the remainder payload was built. A request
  that could never succeed therefore still ended the earlier part of the series. Everything is now validated and
  built first, so a refusal writes nothing. Making the two writes resumable (a durable multi-stage operation
  with per-step results) is still open.
- **"Push: available" no longer stands in for a channel that is not delivering.** The push model collapsed a
  subscription's real state — `renewing`, `failed`, `removed` all became `missing` — and the mail schedule was
  labelled `scheduled_and_push` for every native transport, whether or not a subscription existed. A mailbox
  that only polled therefore read as if instant sync were on. The model now reports each subscription status as
  itself, with a `degradedReason`, the subscription's expiry and last notification, and the schedule label is
  derived from the schedule's own setting and the subscription state: `disabled` when the schedule is off,
  `scheduled_and_push` only when a subscription is actually active, `scheduled` otherwise. The account card reads
  that model instead of the shorthand text, so the line says "not enabled — polling", "renewal error" or
  "polling fallback" as the case is.
- **A calendar link records the provider's version instead of a local hash.** `remote_object_links.remote_version`
  was filled with the SHA-256 of the locally merged iCalendar — a *local* fingerprint that also changes when
  local formatting or local components change — and the only reader that treats that column as a remote ETag is
  the CalDAV write-back, which could therefore send a precondition the provider never issued. Calendar links now
  store the provider's own version (Google's `etag`, Graph's `changeKey`) and nothing when the provider exposes
  none; the local hash stays where it belongs, on the local `calendar_events.etag`.
- **Editing an occurrence that a provider moved far from its original date no longer fails.** Finding the
  provider's id for an occurrence listed a one-day window around the original start, so an exception moved by a
  week was never in the answer and the edit was refused as "occurrence not found". The narrow window is still
  tried first, and a wider (bounded) one only when it found nothing. Two related comparisons were also wrong: a
  date-only match was accepted for *timed* occurrences, so any instance on the same day counted, and a Microsoft
  `originalStart`, which carries no time-zone offset, was parsed in the server's local zone rather than as UTC,
  which made the comparison depend on where Inboxora runs.
- **Splitting a calendar series no longer restarts it or shifts it by a day.** Three defects met in the same
  path. A continued series copied the original rule verbatim, so splitting a series of ten occurrences at the
  fourth created a remainder with ten more instead of the seven that were left. The all-day case wrote the
  series end as a UTC date-time even though an all-day series has a DATE start, which RFC 5545 forbids and which
  named the wrong day. And a Microsoft series ended the earlier part on the previous *UTC* day, which is off by
  one whenever the series' zone is ahead of UTC — a 00:30 Europe/Warsaw occurrence already sits on the previous
  UTC date. The remainder now keeps only the occurrences the earlier part does not (counted by expanding the
  rule), the end value follows the start's type, and the Microsoft end date is the previous calendar day in the
  series' own time zone. A split at the first occurrence, or one whose remainder cannot be represented, is
  refused **before** anything is written rather than leaving a truncated series behind.
- **A deleted Microsoft folder no longer stays a sync target or blocks the whole mailbox.** Folder discovery
  updated the folders the provider listed and did nothing about the ones it no longer had, so a folder deleted
  at the provider stayed a target, kept being synchronised and answered 404 — and because the account's folder
  loop had no error boundary, that single 404 ended the run for every other folder too. A complete folder
  snapshot now retracts the links it does not list (they stop being targets and the next discovery drops them),
  and one folder that cannot be synchronised no longer aborts the others: the failure is counted and logged.
  A lost lease or an unusable connection still stops the run, since those are not one folder's problem. The
  folder walk also reports whether a guard cut it short, so a truncated list is never treated as authoritative.
- **A synchronisation that lost its lease can no longer overwrite a newer one.** Every adapter writes provider
  data in page-sized transactions, but only Gmail renewed its lease and none of them re-checked the generation
  before writing. A run that was superseded — its lease expired while it waited on the network, and another
  worker took over — could still commit its page over the newer projection, and the generations only mattered
  for the cursor. Each page application now runs through a fence: the same statement renews the lease and takes
  the sync-state row lock, and the generation is re-checked inside the writing transaction, so a superseded
  worker is refused and stops applying data. The network request stays outside the transaction, so no lock is
  ever held across a provider call, and a lost lease is reported as `SYNC_LEASE_LOST` rather than as a provider
  failure.
- **An uncertain send can no longer become a silent duplicate.** Two gaps made the same mistake. The server's
  idempotency fingerprint did not cover the message being answered, so two different replies with identical text
  shared it and the second replayed the first delivery instead of being sent (or refused); the answered message
  is part of the request now, and the older fingerprints stay compatible only for a send with no reply context,
  where they are unambiguous. The composer, on its side, cleared its idempotency key as soon as the server
  answered `SEND_OUTCOME_UNKNOWN`, which turned the user's next ordinary click into a fresh send; the key is kept
  so that click lands on the same durable intent and is refused. Sending a second copy is now a separate,
  explicit action that names the duplicate risk and only then mints a new key.
- **One throttled mailbox no longer pauses every other synchronisation.** The schedule kept a single
  installation-wide "next allowed" timestamp: any rate-limited collection pushed the whole pass out for every
  user, provider and collection, and because every adapter reported its own lease conflict as `RATE_LIMITED`,
  even two workers refreshing the *same* collection triggered it. The backoff is now per connection and
  collection kind, honours the provider's own `Retry-After` (bounded and jittered), and clears when that
  collection succeeds. A lease conflict is reported as its own `SYNC_ALREADY_RUNNING` code and is not treated as
  throttling at all: another worker is already refreshing that collection, so the pass leaves it alone and
  nothing else waits.
- **Google contacts deleted while the sync token was invalid are removed again.** The People API reports an
  out-of-date token in the structured error details as `EXPIRED_SYNC_TOKEN`, which the client did not read — it
  recognised only HTTP 410, so a rebuild could be missed — and the rebuild itself only upserted whatever it read,
  so a contact deleted during the gap stayed locally for ever. The structured signal now triggers the rebuild
  whatever status carries it, and a complete rebuild reconciles: contacts it no longer lists are removed and
  their links kept as tombstones, scoped to that address book so another source is untouched.
- **Moving a message between folders no longer deletes its local copy.** A Microsoft folder delta reports
  `@removed` both for a real deletion and for a message that moved out of that folder. The sync deleted by
  account and provider id alone, so when the destination folder's delta had already re-homed the message, the
  source folder's removal deleted it — a correctly moved message disappeared. The deletion is now scoped to the
  folder the delta was read from, so a move converges on one message in the destination whichever delta is
  applied first.
- **The Graph contact request no longer asks for a property the API does not have.** The v1.0 `contact`
  resource has no `anniversary`, and the beta resource names it differently, so it was wrong in both versions
  and can fail the whole `$select` — the same class of mistake that stopped Microsoft mail folder discovery.
  Nothing is requested or sent for it now, and the local column is left untouched: a sync must not clear an
  anniversary the user or another source stored. Graph contacts therefore carry their birthday and every other
  supported field, without the anniversary.
- **A message priority chosen in the composer now reaches Microsoft.** The shared model carries `priority` and
  the SMTP renderer mapped it, but the Graph renderer dropped it, so a high or low priority message arrived as
  normal on a Microsoft mailbox. It is mapped to Graph's own `importance`.
- **A calendar the user disabled is no longer synchronised, and discovery no longer switches it back on.** Both
  calendar syncs selected the connection's calendars without an `enabled` filter — mail already had one — so a
  collection the user turned off kept being pulled and written to, and the "link repair" branch re-asserted
  `enabled = true` and `user_access = 'source'` on a half-finished link, undoing a user's choice. Discovery now
  touches only the provider's own facts (`source_access`, the provider's permission), and Graph refreshes that
  permission on an already-linked calendar too: Google did, Graph returned early, so a share whose write
  permission had been revoked stayed described locally as writable.
- **A listing that stopped at a page limit is no longer treated as the end of the list.** Every provider adapter
  caps how many pages one run reads, and several of them then went on as if the collection had been read
  completely: Graph mail and the Graph and Google calendar rebuilds reconciled deletions against a partial
  snapshot — so a message, contact or event that simply sat on an unread page was deleted locally — and the
  Google and Graph contact syncs reported a successful run whose sync token only ever arrives with the last
  page. Each adapter now returns an `incomplete` flag, skips the destructive reconcile and neither advances the
  cursor nor claims a successful synchronisation when the cap was reached; the next run re-reads from the stored
  token and finishes. The page cap is injectable, like the existing thread budget, so the path is provable.
- **An interrupted Gmail baseline re-reads the page it stopped on instead of skipping it.** The checkpoint stored
  `listing.nextPageToken` — the *following* page — so every thread of the current page that had not been read yet
  was skipped and never stored. It now re-reads the whole label from its first page, which is idempotent and lets
  the label reconcile against a complete snapshot. A budget that happens to end exactly on the last thread of the
  last page is also recognised as a finished label rather than a pause, which previously restarted that label on
  every run and never completed it.
- **Gmail history no longer advances the cursor past pages it did not read.** The history loop is capped, and
  leaving the cap with a page token still set meant the feed had not been read to its end; returning the last
  page's history id then skipped every change on the remaining pages for ever. Completion is now decided by the
  page token alone — many pages can describe the same few threads, so the distinct-thread guard cannot detect it
  — and an unread feed rebuilds from a baseline, which reconciles and captures a fresh history id.
- **A name collision no longer loses the whole discovery.** Several "the local name is taken, try the next
  suffix" loops caught PostgreSQL's `23505` and retried the INSERT on the same client inside the same
  transaction. PostgreSQL aborts a transaction after any SQL error, so the retry could only fail with `25P02`
  and the operation was lost — most reachably when a second provider calendar, address book or mailbox folder
  carries a name a local one already uses. Each attempt now runs under its own `SAVEPOINT`, so the failed
  statement is undone, the transaction stays usable and the suffixed retry actually runs.
- **A partially failed first calendar synchronisation is reported as a failure.** The calendar synchronizers
  resolve successfully while listing the collections they could not read in `errors` — one shared calendar that
  refuses access must not fail the whole consent — but the post-authorization finalizer looked only at
  exceptions, so the opener was told the connection was synchronised while a calendar had not been pulled. The
  errors are now treated as a partial failure: the result says `synchronized: false` with the provider's code,
  and each failed feature records its own state so the card names the part that failed.
- **A current synchronisation failure is no longer hidden behind an older success.** The service row decided
  "connected" before it checked the error, so a failure that arrived after a good run kept showing the green
  state. The failure now takes precedence — authorization, then the current error, then a completed run, then
  "pending" — while the genuine last-success time is still kept in the diagnostics.
- **A partial checkpoint is no longer recorded as a successful synchronisation, and a cleared cursor is actually
  cleared.** Two meanings were collapsed into one statement: `commitSyncCheckpoint` both stored progress and
  stamped `last_success_at`, and it wrote the cursor with `COALESCE($3, cursor)`, which cannot express "clear
  it". An interrupted first synchronisation that had stored one page therefore looked complete, and the baseline
  transition that means to drop a cursor the provider has invalidated silently kept the dead cursor and re-read
  it on the next run. Checkpoint fields now use explicit patch semantics (absent leaves the value, `null`
  clears, a string sets) and a separate `finishSyncRun` records completion; every provider pipeline calls it
  only after the whole declared scope was applied. `completed_watermark` and the page checkpoint follow the same
  rule.
- **The account card no longer reports "never" for a calendar or address book that did synchronise.** The
  diagnostics read `sync_states` by `account_id` and by the raw feature name, but mail state is the only state
  stored that way: the calendar synchronizers record the feature as `calendars` and store it per collection with
  no account id, and the contact state likewise. The query therefore matched mail alone, so a mailbox whose
  calendar and contacts had pulled data still showed "last synchronisation: never". The state is now read where
  it is written (mail by account, calendar and contacts by the verified connection) and the feature name is
  normalised.
- **"Calendars" and "address books" are counted as calendars and address books.** The calendar count was every
  collection of the connection — folders included, which is where "6 collections" came from — and the address
  book count compared `kind` to `contacts`, a value the schema does not allow, so it was always zero. Each group
  now carries only collections of its own kind (`calendar`, `address_book`), and a linked calendar or
  address-book collection counts as a scheduler target even though those collections carry no account id.
- **The reported sync pipeline follows the provider.** A single shared coverage string reported Gmail's
  `history` for a Graph mailbox, whose pipeline is `messages`; the name now comes from the provider that owns
  the feature.
- **Microsoft mail folder discovery asked v1.0 for a field only beta has.** The folder listing selected
  `wellKnownName`, which the `mailFolder` resource exposes in the beta endpoint but not in v1.0 — the endpoint
  this adapter is pinned to. That is a contract violation a strict service answers with `400`, and even when it
  is tolerated the property is absent, so the Inbox/Sent/Trash/Spam/Drafts roles were never recognised and
  Microsoft mail could not be mapped onto the local folders the rest of the application reads. The listing now
  selects only v1.0 properties and resolves each role through `GET /me/mailFolders/{well-known-name}` — the
  documented v1.0 way to address those folders — matching a role by the returned id, never by a display name
  that changes with the mailbox language. A well-known folder the mailbox does not have is skipped; any other
  failure still fails the discovery rather than silently producing a mailbox with no Inbox.
- **"Reconnect" on an account card finishes instead of waiting forever.** The card's connect action asks for one
  consent covering the whole mailbox (`account_enable`), but both OAuth start routes kept a narrower allow-list
  of purposes that did not contain it, so the value was silently rewritten to a plain "new account" flow. That
  flow only stores the authorization, never runs the mailbox's first synchronisation, and its result carried no
  account id — so the card that started it could not recognise the completion and stayed on its waiting state.
  The purpose list is now one shared source of truth used by both providers, by the browser and the device flow;
  an explicitly unknown purpose is rejected with `400` instead of being reinterpreted; and migration
  `0115_oauth_account_enable_purpose` widens the database `CHECK` that rejected the value as well.
- **Reconnecting a mailbox can no longer attach a different provider account.** The callback wrote
  `email_accounts.provider_connection_id` without comparing the identity the provider had just returned with the
  one the mailbox was already bound to, so choosing another account in the provider's own window silently bound
  this mailbox's local data to that account's token. The write now happens in the same transaction as a check of
  the stored issuer, subject and Microsoft tenant; a different identity is refused with its own message and the
  mailbox is left untouched. A re-authorization of the *same* identity — a renamed or aliased address, the case
  the relocation exists for — still works.
- **A duplicated OAuth callback no longer reports success while the first is still working.** The callback reuses
  the flow row when its one-time state has already been consumed, and treated both `completed` and `exchanging`
  as success. A reload or a provider retry could therefore announce a finished connection while the first
  callback was still exchanging the code, and a later failure had no way back to that message. Only a terminal
  `completed` flow now reports success (naming the account), and an in-progress one reports a distinct
  non-terminal state so the card keeps waiting instead of being told the wrong thing.
- **The contacts CardDAV section shows words, not key names.** Six of the fourteen labels that section reads —
  server address, user name, password, synchronise now, connecting, disconnecting — were never added to the locale
  files, so the interface rendered `admin.integrations.carddav.serverUrl` and its siblings. All nine languages now
  carry them.
- **Provider mail is polled every two minutes, not every fifteen.** With no active push subscription the polling
  interval *is* the delivery latency, and fifteen minutes replaced an IMAP fetch that ran every few seconds: a new
  message took "kilkanaście minut" to appear unless the user refreshed by hand. The default is now two minutes;
  `PROVIDER_SYNC_INTERVAL_MINUTES` overrides it and `0` still disables the schedule.

- **A failed first synchronisation is recorded where the card reads it.** The live report was "authorized,
  last synchronisation: never" with no error anywhere: the first run of a calendar or contacts consent threw
  before the sync's own failure recorder was reached, or recorded its error under a coverage the diagnostics do
  not read, so the card showed nothing and the cause had to be guessed. The post-authorization finalizer now
  writes the failure into the feature's own pipeline state (`events`, `personal`, `history`/`messages`), which is
  what the account diagnostics read, and the provider's code is what appears there.
- **CardDAV is managed only from Contacts.** The address-book manager has a Sources section that adds, syncs and
  removes a CardDAV server, so the settings screen no longer carries a second, user-level copy of the same
  connection — the same rule that puts a calendar's sources on the calendar screen. Its now-unused locale keys are
  removed from all nine files.

- **A native account keeps no IMAP or SMTP endpoint.** Both cutovers moved the transport but left `imap_host`,
  `imap_port`, `smtp_host`, `smtp_port`, `auth_user` and `auth_pass` on the row, so the settings showed
  "IMAP imap.gmail.com:993 / SMTP smtp.gmail.com:587" for an account that reads and sends through the provider
  API — fields the transport no longer uses and cannot be edited to any effect. The cutover now clears them, which
  also removes a stored app password from a mailbox that authorizes through OAuth. The account details bar renders
  `Transport: Gmail API` / `Transport: Microsoft Graph` instead of a host and port for those accounts.

- **A reply always carries its threading edge, even when the client's payload does not.** The live case was every
  reply sent from the conversation view arriving with neither `In-Reply-To` nor `References`, so the Sent copy
  orphaned in a conversation of its own while the message it answered stayed alone: the query on the live database
  showed every Inboxora-written `Sent` row with a `Message-ID` and an empty `in_reply_to`, and the raw headers
  confirmed it. The composer now names the message it answers (`replyToMessageId`, the stored row), and the send
  route reads that row's own `Message-ID` (and the References chain, parent's references plus the parent, per RFC
  5322 §3.6.4) when the payload carries no edge — scoped to the caller's own account. The header no longer depends
  on any single client path carrying the value through.

- **The canonical Microsoft callback is served by the Graph flow again.** The legacy mailbox sign-in in
  `oauth.ts` still owned `GET /oauth/microsoft` and `GET /oauth/microsoft/callback`, and that router is mounted
  **before** the provider router — so it served the Graph flow's canonical callback. The Graph flow's own state
  was therefore never found, and every Microsoft calendar or contacts consent ended with "Invalid OAuth state —
  please try again" regardless of what was fixed in the Graph handler: the code that stores the grant, runs the
  first synchronisation and reports the outcome never ran. The two obsolete browser routes are removed (Microsoft
  mail is Graph-native and the account card starts `/oauth/provider/microsoft`); the device-code routes remain for
  the legacy IMAP path, with the token helper they use kept in place. A regression case pins that the path is free
  and that the legacy state error cannot return.

- **A consent says which way it failed, and a repeated callback is no longer reported as one.** Every state that
  was not accepted produced the same "Invalid or expired authorization state", which cannot distinguish a state
  that was never issued from one that expired and from one that a **second** callback presented after the first
  had already stored the grant. Browsers do hit a callback twice (a reload, back/forward, a provider retry), so a
  consent that had succeeded showed an error the user could do nothing about. The callback now reports the
  flow's own state: a repeated callback for a completed or in-flight authorization answers as the success it is,
  an expired one says the authorization took too long, a declined one says so, and only a genuinely unknown state
  asks the user to start again from the account card.

- **A native mailbox is found through the connection that holds its collections, so mail is fetched again.**
  The mail syncs resolved their mailboxes with `email_accounts.provider_connection_id = <the connection being
  synced>`. An identity can have more than one connection row — the one its cutover created and the one a consent
  stored scopes on — and the scheduler walks the connection holding the collections while the account records the
  consent's. When those differed, the sync found **no mailbox at all**: it logged nothing a user could see, wrote
  no error and fetched no mail, which is the reported "total silence" for Gmail and Microsoft. The lookup now
  matches the account by its link **or** by the connection's verified identity, so a mailbox is synchronised
  whichever of its identity's connections the scheduler is walking. Pinned on PostgreSQL: an account linked to a
  different connection of the same identity is still listed for the connection that holds its collections.

- **A consent that fails now says so on the account card.** The popup posted `oauth_error` and only the settings
  screen listened for it, while the account card listened for success alone — so a consent that Microsoft or
  Google refused (a redirect URI that is not registered for that client, a denied consent) closed the tab, left
  the "finish in the new tab" notice up and changed nothing else. It read as "I clicked Connect and nothing
  happened". The card now clears that notice and shows the provider's own reason, and a successful consent
  clears an earlier failure.

- **A calendar or contacts consent now points the mailbox at the connection its grant was stored on.** The
  reported symptom was mail working while a calendar or contacts consent appeared to grant nothing: the card kept
  saying `Calendars.ReadWrite` was missing. A mailbox records the connection it was moved with, and the consent
  stored its scopes on the connection that identity resolves to; when those are two rows for one identity, the
  features were read from the wrong one. All three completion sites (Google, and Microsoft's browser sign-in and
  device code) now re-link the target mailbox to the connection they stored the grant on, inside the same
  transaction, so the authorization and the features can no longer diverge. Pinned on PostgreSQL: an account
  pointing at a stale connection reports the feature as unauthorized with the scope missing, and once it points
  at the identity's connection the accumulated grant authorizes calendar and contacts with nothing missing.

- **Published `:dev` revision.** Frozen code SHA `f0eba45c`, built for `linux/amd64` and `linux/arm64`: backend
  `sha256:8314505d…`, frontend `sha256:911b65fd…`. Verified on the published pair: fresh smoke (health, version,
  UI root, register, login, `/api/auth/me`, accounts, calendars, address books, 117 migrations, 0 restarts) and an
  upgrade smoke from a 4.0.4-state database (110 → 117 migrations, healthy, 0 restarts).

- **A failed mail sync says why, instead of `INTERNAL_ERROR`.** Both mail syncs classified only their own
  provider's API error, and an authorization failure — a missing scope, a revoked grant, a refresh that the
  provider refused — arrives as a `ProviderAuthError`, which is neither. Every such failure was recorded as
  `INTERNAL_ERROR`, which is the one code that tells a user nothing; the calendar and contacts syncs already
  reported it correctly. Both mail syncs now classify `ProviderAuthError` by its own code at both failure sites
  (folder discovery and the message page), so the diagnostics show `PROVIDER_AUTH_REQUIRED`,
  `INSUFFICIENT_SCOPES` or `REAUTH_REQUIRED` and the action that follows from it. `INTERNAL_ERROR` is left for an
  exception that is genuinely unexpected.

- **The automated-series mode cannot merge ordinary human mail.** `automated_series_mode = 'strict'` is the one
  path that can place two messages in the same conversation without an RFC edge, because the ingest adopts the
  previous series' conversation. Pinned on PostgreSQL, through the real ingest, for a generic IMAP account with
  the mode enabled: two ordinary messages that share a subject and carry no authenticated sender evidence stay
  two conversations. The decision itself already requires authenticated sender evidence on both sides, matching
  sender and recipient signatures and a matching references anchor, so subject alone is never enough.

- **One Microsoft identity keeps one connection across its consents.** Pinned on PostgreSQL: a mail consent, then
  a calendar consent, then a contacts consent all resolve to the same `provider_connection` (the subject and
  issuer identify it, and signing in with another alias of the same account does not fork it), the account's
  `provider_connection_id` still points at it, one Graph grant holds `Mail.ReadWrite`, `Mail.Send`,
  `Calendars.ReadWrite` and `Contacts.ReadWrite` together, a later consent that returns no refresh token does
  not clear the first one, and the account card then reports mail, calendar and contacts as authorized with no
  missing scopes.

- **The account card updates itself when its authorization finishes.** The OAuth popup now hands the opener the
  provider, the purpose, the account and whether the first synchronisation ran (never a token or a connection
  id), and `AccountProviderServices` reacts only when the message comes from its own origin and names **its own**
  account: it clears the "finish in the new tab" notice and refetches the features, the diagnostics and the
  account list, so a calendar or contacts row changes without a page reload — and an authorization for another
  mailbox cannot make this card claim a result it does not have.

- **A consent now runs the synchronisation it implies, immediately.** Connecting a calendar or contacts left the
  feature authorized and empty until a scheduler tick: the live report was a Google calendar with six
  collections and "last synchronisation: never", and contacts authorized with no address book. Both provider
  callbacks (Google, and Microsoft's browser sign-in and device code) now call one finalizer after storing the
  grant, which runs the first calendar, contacts or mail-baseline synchronisation for the purpose the flow
  carried. The grant is never rolled back because that run failed: the outcome is reported as `authorized` with
  `synchronized`/`syncErrorCode`, and the callback hands the opener the provider, the purpose, the account and
  those three facts — never a token — so the account card can update without a page reload.

- **Published `:dev` revision.** The image now contains the fixes for the alias send, the contacts manager's
  close and compact trigger, Gmail mail polling (`mail_label`), the diagnostics reading the message pipeline,
  the account-to-connection resolution, and the per-feature `authorized`/`synchronized`/`syncPending`/
  `syncErrorCode` state.

- **The scheduler's target query is confirmed against the collections the providers actually create.** A native
  Gmail connection whose mail collection is a `mail_label` linked through `local_folder_id` reaches
  `listProviderSyncTargets()` and runs the Gmail message sync, a Graph `mail_folder` collection does the same,
  and a collection with no local link stays out of the list. Pinned on PostgreSQL, so the polling fallback
  cannot silently lose a mailbox again.

- **Mail diagnostics report the message pipeline, not the discovery step.** A feature writes more than one kind
  of run: Gmail's label discovery records `labels` and its message/history pipeline records `history`, Graph's
  folder discovery records `folders` and its messages record `messages`. The per-account diagnostics read the
  newest row for the feature, so a discovery run was reported as a completed mail synchronisation — the live
  symptom `lastSuccessfulSync` set with `cursorPresent = false`, which is a label run with no history cursor
  behind it. The diagnostics now read each feature's own pipeline coverage (`history`/`messages`, `events`,
  `personal`), so discovery can never stand in for synchronisation and `cursorPresent` answers the question it
  claims to.

- **Gmail mail is polled again.** Google's label discovery records its collection as `mail_label`, while the
  scheduler's dispatcher only recognised Graph's `mail_folder`. A native Gmail connection therefore had no
  scheduled message sync at all: new mail appeared only after a manual synchronisation or a push notification,
  which is the "mail does not arrive by itself" a live round reported. Both collection kinds now run the Gmail
  label and message sync, so the polling fallback works with or without push.

- **Authorization and synchronization are reported as the two separate facts they are.** A service row knew
  only whether a grant existed, so a mailbox whose provider authorization had succeeded but whose first
  synchronization had failed was shown as "not connected" — which sends the user to reconnect an account that
  is already authorized. Each feature now carries `synchronized`, `syncPending` and `syncErrorCode` beside
  `authorized`, and the account card renders four states: not connected, connected, connected with a
  synchronization in progress, and connected with a synchronization failure (which names the code).

- **An account resolves the connection it was actually moved with.** The account's provider features were
  matched to a connection by comparing the mailbox address with the connection's `provider_user_id`. Microsoft
  reports the mailbox's primary address there, so a consent granted while signed in with an alias — or for a
  mailbox whose primary address differs from the one the account stores — resolved to no connection, or to a
  second connection holding only that feature's scopes. The card then read "missing Calendars.ReadWrite" while
  the grant existed. The connection the account records (`provider_connection_id`) is now authoritative and the
  verified address is the fallback, so mail, calendar and contacts of one identity are read from one
  connection.

- **A message sent from an alias leaves as that alias, or fails visibly.** The Graph payload carried no `from`
  at all, so Graph sent as the mailbox's primary address: the composer showed `kamil.maciag@outlook.com` and the
  recipient saw the primary identity, with nothing in the interface to say the choice had been ignored. The
  selected sender is now the payload's `from.emailAddress.address`, and a mailbox that may not send as it gets
  Graph's own refusal reported as `SEND_AS_DENIED` instead of being flattened into "insufficient scopes" (which
  sent users to re-authorize an account that was already authorized) and instead of a silent fall back to the
  primary address.
- **The contacts manager can be closed.** The panel was rendered unconditionally, so closing it changed the
  state and left the dialog on screen — it opened and could not be dismissed. It now exists only while it is
  open, which makes the X, Escape, the backdrop and the mobile Back action all work. Its trigger is a compact
  icon button (34 px desktop, a 44 px touch target on mobile) with an accessible name and tooltip, instead of a
  full-width labelled button competing with the address-book strip.

- **The contacts manager is a panel, not an ellipsis menu.** The `⋯` control held a dozen unrelated actions
  with no way to tell which address book each applied to. It is replaced by a manager that lists the books with
  their source, visibility and read/write state, and shows the selected book's settings in sections: general,
  synchronisation, write-back, DAV, import/export formats (Google CSV, Outlook CSV, vCard) and a danger zone.
  A provider collection no longer offers what only a local book can do — it cannot be renamed, imported into or
  deleted here, and it says so — and the last local book cannot be deleted. Connecting Google or Microsoft
  contacts is still done on the mailbox card in Settings → Accounts, never from this panel.
- **A failed calendar or contacts synchronisation says what failed.** "1 failure" is replaced by the first
  concrete reason: a missing scope names the scope and the service to reconnect, an authorization the provider
  refused shows its code, a rate limit says to wait, and a provider error shows its status. When a run had more
  than one failure, the count of further failures follows. The synchronisation is also refused before the
  request when the grant cannot authorize it, so a certain 403 is not spent on a round trip.
- **Each account shows its own provider diagnostics.** A collapsed section on the account card reports the
  connection (provider, identity, status), and per feature — mail, calendar, contacts — whether it is
  authorized, which scopes are missing, when it last succeeded, its last error code, whether a synchronisation
  cursor exists, and its push and schedule state. It is read from the server for that account alone, and no
  token, secret or provider payload is part of it.

- **A sender's name is decoded with the charset its header declares.** Every RFC 2047 encoded word was decoded
  as UTF-8, so a message whose client used a legacy Polish charset — ISO-8859-2, or Windows-1250 as Outlook
  emits — produced replacement characters: `Kamil Maciąg` arrived as `Kamil Maci?g` in the message list, in the
  reading pane and in a reply that reused the name. UTF-8 mail was unaffected, which is why the fault looked
  intermittent. The declared charset is now honoured through the same decoder the body path already used, a
  language tag on the label is ignored (`=?utf-8*en?Q?...?=`), and an unknown label falls back byte-for-byte
  instead of decoding twice as UTF-8.

- **Authorizing one Google (or Microsoft) feature no longer revokes another.** A provider connection keeps one
  grant per audience, and Gmail, Calendar and People share the Google audience (as Graph's mail, calendar and
  contacts share Microsoft's). Storing the newly granted scopes verbatim therefore replaced the whole list: a
  mailbox authorized for Gmail stopped being authorized for its calendar the moment the calendar consent
  landed, which is exactly the shape a live acceptance round reported as "0 calendars, failures: 1". The
  stored scopes are now the union of what the connection already held and what the authorization returned,
  with an explicit `dropScopes` input for the case where the provider itself reports a revocation.

- **A database from an earlier `:dev` could still hold legacy provider ids behind the unique index.**
  Correcting migration 0108 fixes an upgrade from 4.0.4, but a database that had already applied the *first*
  revision of 0108 (recorded under its old checksum, so the corrected file is not re-run) kept the legacy
  X-GM-MSGID values on its Gmail IMAP accounts while the index existed. A later IMAP COPY or a new label can
  insert a second physical row for a message whose provider id is already present, which failed with `23505`.
  New migration `0114` applies the same normalisation unconditionally, so the state no longer depends on which
  revision of 0108 a database ran: it is a no-op on a clean 4.0.4 upgrade, clears the leftovers on an earlier
  `:dev`, and never touches a native account. An `UPDATE … SET NULL` cannot violate the index, and no row,
  `uid`, `folder`, `thread_key`, `provider_thread_id` or Conversation Engine value is changed.
- **Upgrading an existing 4.0.4 database could stop at migration 0108.** The migration created a unique
  index on `messages (account_id, provider_message_id)` as if that column had always been a native provider
  identity. It had not: it arrived with Conversation Engine v2 as *threading evidence*, and on a Gmail IMAP
  mailbox it holds X-GM-MSGID, which is mailbox-wide — so the same message legitimately carried the same id
  once per folder/label copy (INBOX, `[Gmail]/Important`, `[Gmail]/All Mail`, custom labels) because the
  relocate/COPY path preserves it. A real mailbox with 19231 such rows and 7445 distinct ids failed the index
  with `23505`, and the backend stopped there on every start. The migration now clears that column for the
  accounts whose own transport is the legacy one (`mail_transport` NULL or `imap_smtp`) before creating the
  index, leaves it untouched for accounts already on a native transport, and touches nothing else: no row is
  deleted and `provider_thread_id` (X-GM-THRID), `thread_key`, `uid`, `folder`, `message_id` and every
  Conversation Engine column keep their values. Gmail threading is unaffected. Covered by a 4.0.4 → 4.1.0
  upgrade integration test that builds the historical schema with the production migration runner and
  upgrades it the way the backend does at start-up.

- **Google mail was not in the scheduled refresh.** The Microsoft side refreshed mail on the schedule and
  the Google side did not, so a Gmail mailbox was only synchronised when someone asked for it or when it had
  push. Both are refreshed now, which is also what makes polling a real fallback for Gmail.
- **"Sync this folder" opened an IMAP session for a native account.** The on-demand folder sync addressed its
  account by id without asking which transport owned it; it now dispatches through the provider, and the IMAP
  path refuses a native account as a second line of defence.

- **An inbox rule can forward mail from a native Gmail account.** Forwarding a message from a
  Gmail-API account was refused ("Forwarding from a gmail_api source is not supported yet"), which made rule
  forwarding — one of the account's core features — regress on the transport the migration recommends. The
  forwarder now reads the body through the same Gmail reader the message view uses, reads attachments through
  the shared source dispatcher, and sends through the account's own transport seam: no IMAP session is opened
  and no SMTP fallback exists for a native account. Microsoft Graph and IMAP/SMTP keep their behaviour.
- **"Sync this folder" on a native account no longer tries IMAP.** The on-demand folder sync addressed its
  account by id without asking which transport owned it, so a Graph or Gmail account would have been read over
  IMAP. It now dispatches through the same provider target the manual sync uses, and the IMAP path refuses
  loudly as a second line of defence.

- **A truncated series could carry both `UNTIL` and `COUNT`.** Ending a series before an occurrence set the
  boundary but left the original occurrence count on the rule, and RFC 5545 forbids the pair; a client that
  validates the rule rejects it. The count is now dropped when the boundary is set, leaving one end.
- **A provider collection write could not be journalled for contacts or calendar events** (the provider's
  identifier was written into the journal's local-resource column); the local id is recorded and the provider
  id travels in the payload and the remote-object link.
- **A Google collection could never actually be opted in for write-back.** The Calendar and People syncs
  recorded the collection as read-only at the source, which made the write-back switch refuse every Google
  collection. They now record what the provider reports (a calendar's `accessRole`, the People API's answer
  for the user's own contacts) and refresh that fact without touching the user's choice.


- **A provider contact or calendar-event write could not be journalled at all.** The provider-operations
  journal stores Inboxora's local resource id, but the Microsoft write paths wrote the *provider's* id into
  it, so every contact and calendar-event update or delete failed at the database before reaching Microsoft.
  The journal now records the local id and the provider id travels in the payload and the remote-object link.
- **A Google collection could never actually be opted in for write-back.** The Calendar and People syncs
  recorded the collection as read-only at the source, which made the write-back switch refuse every Google
  collection. They now record what the provider reports (a calendar's `accessRole`, the People API's answer
  for the user's own contacts) and refresh that fact without touching the user's choice.
- **Contacts had no write-back switch.** The per-collection opt-in existed on the calendar surface only: the
  address-book list did not return the collection a book belongs to, and the address-book menu had no control,
  so writing a pulled Google, Microsoft or external CardDAV book back to its source was reachable only through
  the API. The list now reports each book's collection and the capability model's read-only verdict, and the
  menu offers the same switch the calendar sidebar does.
- **An external CalDAV/CardDAV collection had no link for the write-back switch**, so the write-back could not
  be enabled for any real collection even though the client was implemented. The external syncs now create
  the source connection and collection link for every collection they import, and a real-PostgreSQL suite
  proves the link, its idempotency and the writable/read-only decision per source kind.
- **A provider collection was advertised as DAV-writable when the DAV handlers cannot write it.** The DAV
  access mode was computed from the adapter's write-through flag, so an opted-in Graph or Google collection
  could be written over DAV and applied locally, where the next provider sync discards it. The DAV mode now
  requires the DAV channel to be able to forward the write, so a provider collection is DAV read-only while
  remaining writable over the web interface.
- **A Microsoft account could be silently switched by a cutover that named another mailbox's connection.** A
  migration whose explicit connection does not belong to the account's own address is now refused by name
  unless the operator deliberately overrides it.
- **An inbox rule that forwards mail opened IMAP for a native account** and then hit the transport's
  deliberate refusal, so the forward could not work. It now reads the source message over the account's own
  transport and dispatches through the send seam; an accepted forward is recorded as sent, a definite refusal
  releases the reservation for a deliberate retry, and an unknown outcome stays pending so a later run
  reconciles instead of sending twice.
- **Bulk read/unread opened an IMAP connection for a native account** and reported success regardless of the
  outcome; every message-mutating route now dispatches on the account's transport.
- **The message list opened an IMAP session for a Microsoft Graph account** on every listing; body prefetch
  now follows the account's transport.
- **A provider calendar rebuild did not reconcile.** When the provider rejects the sync cursor, the rebuild
  now removes what the provider no longer reports instead of leaving stale events behind.
- **An oversized message rejected by the forwarded-attachment backstop answered without a domain code**, so a
  client had to match English text; every size refusal now carries its code, dimension and byte figures.
- **A blind recipient could have been dropped from the delivered copy.** The composed artefact no longer
  carries a `Bcc:` header, so the accounting counts what is actually sent and blind recipients live in the
  delivery envelope only.
- **A draft whose identity is a large numeric id could not be reopened.** The draft identity parser now
  accepts the numeric-string form the database returns.

### Security

- **Blind recipients never travel in a composed artefact.** The `Bcc:` header is stripped where the message is
  composed and measured, so a buffer handed to a transport cannot disclose the blind recipient list. The
  Gmail API is the documented exception in the other direction: its message resource has no envelope field and
  its send delivers to the addresses in the headers, so that arm keeps `Bcc:` and relies on Gmail to keep it
  off delivered copies; a test asserts a blind address appears in no visible field.
- **DAV application passwords can only narrow access.** A password's ceiling is combined with the collection's
  own mode so it can never widen what a collection or its source allows, and a provider-sourced collection
  refuses writes whatever the password permits.
- **External DAV and ICS sources are validated and their credentials encrypted.** Server URLs are checked
  against the connection policy (public hosts require HTTPS; plaintext is allowed only for a private address
  when the administrator enables it), and stored credentials remain encrypted at rest.
- **Provider routes are ownership-scoped.** Collection lookups, notice suppression and migration all filter by
  the signed-in user, and a foreign account or collection is answered as not found.

## [4.0.4] - 2026-09-18

### Changed

- The desktop (Electron) build now draws an integrated title bar instead of the OS window
  frame, so Inboxora's own bar reaches the top edge: Back, Forward, Search (the existing
  Inboxora search, also on `Ctrl+E` / `Cmd+E`) and Settings. Window controls stay native
  through Electron's Window Controls Overlay, so minimize / maximize / close and
  close-to-tray are unchanged, and the bar's colours follow the active Inboxora theme
  (light or dark) without a restart. The web/PWA build and the Android build render no
  desktop title bar.
- Back / Forward in the desktop title bar walk Inboxora's own view history (mail → message →
  Calendar → Contacts → Settings, including the selected account, folder and open message)
  instead of the browser's navigation history, which only ever contained login/OIDC pages
  because Inboxora swaps application state rather than loading documents. A restored message is
  re-resolved by its exact row id first and, only when that row is gone, by its durable reference
  — the RFC `Message-ID` header when it is known, scoped to its account, else the row id — then
  parked where the reading pane can find it. So "Back" returns to the exact copy the user was
  reading (the same Message-ID can exist in INBOX and Archive, and the durable lookup prefers the
  INBOX one), and still finds the message after a move or re-sync gave it a new physical row id.
  Settings opens as an overlay *below* the bar, so the arrows and search stay usable while it is
  open.
- The visible `File / Edit / View / Window / Help` menu bar is removed on Windows and Linux.
  Its accelerators are re-registered on the window — `Ctrl+R` reload, `F11` full screen,
  `Ctrl+W` close (still hide-to-tray), `Ctrl+M` minimize and `Ctrl+,` Change Inboxora Host —
  and native clipboard shortcuts are unaffected; Change Host and Quit remain in the tray, and
  macOS keeps its system application menu.
- Desktop native notifications are now controlled by Inboxora instead of being unconditional.
  The preference lives in Settings → Notifications → *System notifications* and is stored
  locally per installation (`desktopNotifications.enabled`, default on) in the Electron config
  under `app.getPath('userData')` — never synced as an account setting and independent of
  VAPID. The Electron main process reads it before showing anything, so turning notifications
  off blocks them on every path, not just in the React layer.
- Inside the desktop shell the Web Push / VAPID settings section is replaced by the
  system-notification settings, the app no longer registers its service worker there (it
  existed only for Web Push), and an existing Web Push subscription left by an earlier desktop
  build is unsubscribed and unregistered on first run. Electron shows native notifications only
  from the Inboxora WebSocket, so a single message can no longer produce two operating-system
  notifications. Browser and PWA Web Push are unchanged.
- The desktop notification status line no longer claims more than it knows. `Notification`
  support, the Inboxora switch and the operating-system state are reported separately; on
  Windows the OS state is read from the notification registry instead of being assumed from
  support alone, and the wording is "enabled in Inboxora" until a test notification is actually
  confirmed. The state is re-read whenever the window regains focus — which is exactly what
  happens after using the "open system notification settings" shortcut — and a confirmed test
  outranks a stale reading, so the card cannot keep reporting a state the user already fixed.

### Added

- Desktop notifications settings section (Electron only): enable/disable, an honest status line,
  and a *Send test notification* button that goes renderer → preload → IPC → Electron
  `Notification`. The result is what the operating system reported — `confirmed` only after
  Electron's `show` event, a distinct "sent but not confirmed" state when no event arrives, and
  the failure reason otherwise — so a silently blocked Windows toast is visible instead of
  reported as success. A shortcut to the operating system's notification settings is always
  available where the platform provides one (Windows and macOS), not only after a failure.
- The Windows desktop build can now be chosen as the default email app and `mailto:` handler
  from Inboxora itself. Settings → Notifications → *Default email app* reports whether Inboxora
  is the current handler, offers *Set as default*, and opens the Windows default-apps page —
  the per-app page on Windows 11, the general list on Windows 10 — where the user confirms the
  choice. Windows 10/11 do not let an application make itself the default, and the card says so
  instead of implying otherwise. The status requires a *complete* registration (the `mailto`
  association, the `RegisteredApplications` entry and the launch command), so a partially
  written one is not reported as registered — not even when Windows still points at Inboxora,
  which would otherwise claim a default that cannot work and hide the repair. On Windows the app
  no longer writes Electron's legacy `HKCU\Software\Classes\mailto` handler: it registers only
  its own ProgID, so launching Inboxora offers it as a *choice* instead of claiming the generic
  key, and the installer removes a legacy handler left by an earlier build (only while it is
  still Inboxora's own command). The installer and the app both register the
  email-client capabilities (now including `ApplicationIcon`) and the `Inboxora.mailto` ProgID,
  and the shell is told the associations changed (`SHChangeNotify(SHCNE_ASSOCCHANGED)` with
  `SHCNF_FLUSH`) after installing and after re-registering; the in-app re-registration waits for
  that notification (bounded, best-effort) so the Default apps page opened right after it
  already shows the new state.
- Scoped Electron IPC for the desktop features — notification settings/test, mail-handler
  settings/registration and title-bar theming — exposed through the sandboxed preload, with
  sender *and* sender-frame-origin validation in the main process (the same webContents also
  hosts the setup page and, during an OIDC login, the identity provider's document) plus strict
  validation of every accepted value.
- Regression tests: `frontend/packages/electron/desktop-settings.test.cjs` (notification
  preference, overlay-theme validation, menu/overlay platform policy, Windows registry state
  parsing), `frontend/src/utils/desktopShell.test.ts` (shell detection, title-bar height
  contract, theme-colour parsing), `frontend/src/utils/viewHistory.test.ts` (the Back/Forward
  history rules), `frontend/src/components/desktop/useAppViewHistory.test.ts` (Back/Forward
  restore driven through the real store actions, including a message whose folder page was
  replaced and the session/navigation guards around an in-flight lookup) and
  `frontend/src/utils/desktopWebPushCleanup.test.ts` (the Web Push migration).
- The canonical repository is now a standalone GitHub repository,
  [`Dragonk/Inboxora`](https://github.com/Dragonk/Inboxora), which is no longer a fork of MailFlow
  and is no longer part of its fork network. Git history, branches, tags, release assets, labels
  and repository settings were carried over 1:1; the previous repository is archived read-only as
  [`Dragonk/Inboxora-archive`](https://github.com/Dragonk/Inboxora-archive). No application code,
  database schema, migration or deployment configuration changed.
- Operator action after the move: the repository Actions secrets were re-created in the new
  repository — `MAILFLOW_ANDROID_KEYSTORE_BASE64`, `MAILFLOW_ANDROID_KEY_ALIAS`,
  `MAILFLOW_ANDROID_KEY_PASSWORD`, `MAILFLOW_ANDROID_STORE_PASSWORD`, `ANDROID_DEV_KEYSTORE_BASE64`,
  `MAILFLOW_WINDOWS_CSC_LINK`, `MAILFLOW_WINDOWS_CSC_KEY_PASSWORD`, `INBOXORA_GPG_PRIVATE_KEY` and
  `INBOXORA_GPG_PASSPHRASE`. Secret values are not readable through the GitHub API, so the Android
  and Windows material was re-created from the local signing archive in `.toolchain/release-signing/`
  (gitignored) and the GPG key was generated for this purpose.


- Signed release artifacts: every publish run attaches a GPG-signed `SHA256SUMS` manifest covering
  the Linux `.deb`/`.rpm`, Windows `.exe` and Android `.apk`/`.aab` files, together with the public
  key as `inboxora-signing-key.asc`. Verify a download with
  `gpg --verify SHA256SUMS.asc SHA256SUMS && sha256sum --check --strict SHA256SUMS`. The signing key
  is committed at [`docs/keys/inboxora-release-signing.asc`](keys/inboxora-release-signing.asc)
  (RSA 4096, `Kamil Maciąg (Inboxora) <kamil.maciag@outlook.com>`, fingerprint
  `B26C 6D74 C04C E0B8 3648 16D9 2C96 71F8 1ED3 2471`, expires 2029-09-17).
  The step fails the release if the manifest is empty or does not match the artifacts.
- Windows installers are Authenticode-signed using `MAILFLOW_WINDOWS_CSC_LINK` (base64 PKCS#12) and
  `MAILFLOW_WINDOWS_CSC_KEY_PASSWORD`; the certificate subject is
  `O=Inboxora, CN=Kamil Maciąg, emailAddress=kamil.maciag@outlook.com`. Known safe limitation: that
  certificate is currently self-signed, so SmartScreen still reports an unknown publisher — replace
  it with a CA-issued code-signing certificate (or Azure Trusted Signing) before relying on it for
  public trust.
- Linux package integrity: the `.deb`/`.rpm` files are covered by the signed `SHA256SUMS` manifest;
  they carry no embedded `debsigs`/`rpmsign` signature yet.
- The `Release` workflow can now be dispatched for an existing tag (`workflow_dispatch` with a `tag`
  input) to (re-)publish the versioned container images (`vX.Y.Z`, `X.Y.Z`, `latest`) from this
  repository without moving or re-pushing the tag. The run asserts that the tag exists and that the
  checked-out revision is exactly the tagged commit before building.
- Pull requests are reviewed by CodeRabbit before merging. `.coderabbit.yaml` turns on automatic
  reviews for PRs targeting `dev`, keeps the legacy `CodeRabbit` commit status as the required-check
  surface, and adds path filters plus project-specific review instructions (migration discipline,
  privacy/idempotency boundaries, no swallowed errors). The `Inboxora PR gate` ruleset on `dev` and
  `main` requires that status, the core CI checks, one approving review and resolved review
  conversations. The ruleset starts in `evaluate` mode and is switched to `active` once the
  CodeRabbit GitHub App is installed, so the gate cannot block merges in the meantime.

### Fixed

- Android workflows no longer fail on `android-actions/setup-android@v3`: the action's default
  package list still contains the legacy `tools` SDK package, which Google removed from the SDK
  repository, so `sdkmanager` aborted with `Failed to find package 'tools'`. Both
  `publish-apps.yml` and `android-dev-build.yml` now request only `platform-tools`.
- Android release builds no longer ship a lower `versionCode` than the previously published APKs.
  The code came from `github.run_number`, which restarts whenever a repository is re-created: after
  the move to the standalone repository, 4.0.3 was built with `versionCode 2` and Android rejected
  the package as a downgrade over the installed 4.0.2 (`versionCode 9`). The code is now derived
  from the version itself (`major * 1e6 + minor * 1e4 + patch * 1e2`, minus 50 for pre-releases),
  so it is stable across repositories and strictly increasing along the release line; 4.0.3 is
  rebuilt with `versionCode 4000300`. Covered by `set-app-version.test.cjs`.

## [4.0.3] - 2026-09-18

### Fixed

- Remove automatic physical-message relocation based solely on Message-ID. Two distinct copies that
  share an RFC Message-ID (self-sent Gmail, mailing-list mirrors) now persist as separate physical
  rows keyed by `(account, uid, folder)`; Conversation Engine logical dedup handles the grouping.
- Start IMAP IDLE explicitly on persistent sync connections instead of relying on ImapFlow's delayed
  auto-IDLE, which never fired at the supported 15-second sync interval. Adds observability for
  accounts that support IDLE but never entered it.
- Refresh each non-INBOX folder's STATUS watermark after LIST and skip on-demand sync when the server
  UIDNEXT, message count, and unseen count match the cache. New `folders.uid_next` column; folders
  with advanced UIDNEXT are queued for a metadata sync even though only INBOX is IDLE-monitored.
- Fix STATUS gate self-cancellation: `uid_next` is now the watermark of the last completed sync, not
  the last observed STATUS, so detecting a change no longer writes the new value before the fetch runs.
- Harden explicit IDLE: track `idleAttemptedAt` separately from `idleEnteredAt` (health check uses the
  latter), and guard concurrent `_enterExplicitIdle` calls with a per-account single-flight promise.
- Add a one-time post-relocate repair: per account, a SEARCH-ALL/UID-diff pass over every
  selectable folder re-fetches only the missing UIDs (including old holes a bounded recent-window
  scan would never revisit). Completion is recorded in the new `account_maintenance_state` table
  (migration `0096`) — never as a pseudo-folder row, which `syncFolders()` would prune and
  `backfillAllFolders()` would try to SELECT on IMAP. The in-process guard covers only runs in
  flight, so failed runs retry on the next tick instead of waiting for a restart; each folder is
  re-diffed after repair and the marker is written only when every folder verifies clean, so a
  parse failure that leaves a UID missing does not mark the account repaired.
- Fix a double IMAP MOVE in `moveSpamCopy()`: the old body fired `moveMessage()` once inside an
  eagerly-started promise and a second time for the first caller. The method now issues exactly
  one MOVE per physical copy, coalescing concurrent callers onto the same promise (the pipeline
  keeps its own single-flight; the manager map guards direct callers), with regression tests for
  single-caller, concurrent-callers and reject paths.
- Harden antispam auto-move: automatic MOVE is INBOX-only (classification/tagging still runs
  everywhere; Sent, Archive and custom folders are never auto-moved), and the physical row is
  re-read immediately before the MOVE — a copy relocated by Inbox Rules / the Block List, deleted,
  or given a user override in the meantime is skipped, so the override always wins including
  under races.
- Project `m.spam_verdict` / `m.spam_score_ml` in the flat and threaded list queries,
  `GET /mail/thread/:threadId`, `GET /mail/messages/:id` and `GET /mail/resolve-message` so the
  mounted `SpamBadge` actually receives data end-to-end (including the threaded final projection
  from `ranked`, not just the `deduped` CTE).
- `POST /api/spam/retrain-now` retrains only the caller (available to every user, matching the
  per-user SpamSettings UI); fleet-wide rebuilds move to admin-only `POST /api/spam/retrain-all`.
- Concurrent auto-move callers share the first caller's outcome verbatim instead of reporting
  `moved=true` for a revalidation-skipped move; the post-relocate repair no longer marks an empty
  local folder list as complete and runs under the per-host background-connection budget.
- Gate ML maturity on distinct usable samples: `retrainFromRecords` counts unique messages (by
  Message-ID, else account/uid/folder) with real features per class into new `spam_models`
  `usable_spam` / `usable_ham` columns (migration `0097`); ML activates only at `>= minRecords`
  usable samples with a minimum of each class (default 10), so one mail confirmed 50x or 50 spams
  with zero hams stays rules-only, and legacy featureless rows no longer mature the model.
  Manual feedback is persisted through `recordManualFeedback`, which runs the training_log INSERT
  (now carrying a stable `training_identity`, migration `0098`) and the incremental model update
  inside one per-user serializer hold — concurrent mark-spam clicks on the same mail cannot both
  mint a distinct sample, and a repeat confirmation is logged without changing the vocabulary or
  the usable counters.
  Full retrain groups rows by `training_identity` with latest-decision-wins: a Spam→Ham correction
  moves the sample and retrains the vocabulary on the newest label only, independent of row order.
- Make the training identity stable for messages without a Message-ID: the normalized content hash
  now takes precedence over the `(account, folder, uid)` triple, so a Spam→Ham correction keeps ONE
  identity instead of splitting the same mail into two samples after the server re-keys folder+UID.
  SQL normalization is unified with the TypeScript rule (migration `0099` re-derives identities on
  databases that applied the first `0098` revision; the replaced unreleased `0098` checksum is
  accepted so those databases keep booting).
- Give manual feedback latest-decision-wins semantics in the incremental model too, not only after a
  full retrain: `recordManualFeedback` reads the latest prior decision for the identity (regardless
  of label), then either adds a new sample, logs a repeat confirmation without touching the
  vocabulary or usable counters, or rebuilds the model from the log when the label flips. The whole
  sequence now runs in one database transaction (`withTransaction`), so the training row and the
  model row commit together — the incrementally maintained model equals the post-retrain model, and
  ML can no longer mature prematurely between a correction and the next retrain.
- Add `messages.spam_score_blended` (migration `0100`), written by the classifier and projected
  through the flat/threaded list, thread, message and resolve-message queries. `SpamBadge` now shows
  the score the verdict was actually decided on; rows classified before the column existed show the
  chip without a percentage instead of the misleading ML-only number.
- Report antispam maturity in `SpamSettings` from distinct usable samples (with a per-class
  breakdown and the raw feedback-event count as context) instead of the raw row count.
  `GET /api/spam/status` derives maturity from the configured thresholds and the usable split;
  `PATCH /api/spam/thresholds` validates `minRecords`/`softRecords`, enforces
  `softRecords >= minRecords`, and drops the dead `hardRecords` key; `spamModelStore` per-user
  lock map entries are released after each run.
- Keep the other accounts' antispam training effective after a per-account reset:
  `POST /api/accounts/:id/spam/reset-training` now deletes that account's feedback rows and
  immediately rebuilds the per-user model from the remaining records (falling back to rules-only
  when nothing is left to learn from or the rebuild fails) instead of deleting `spam_models`
  outright, which left every other account untrained until the next scheduled retrain.
- Add a hybrid antispam classifier (deterministic 14-rule engine + per-user multinomial Naive Bayes):
  rules always on, ML joins at the configured `minRecords` (>= 50 default), verdict at the configured
  `spamThreshold` (>= 0.85 default), auto-move at the configured `autoMoveThreshold` (>= 0.95 default)
  with ML backing only; manual /spam and /ham write one atomic training row with mark-time features
  (also on the already-in-folder path) and train incrementally through a per-user serializer; a
  staggered hourly single-flight scheduler rebuilds models with exponential time decay and awaits slow
  users instead of overlapping; ingest tagging is fire-and-forget and backfill defers auto-move to
  avoid IMAP connection storms; auto-moves resolve the full account row, share one in-flight MOVE per
  physical copy, and keep folder badges in step; `GET /api/spam/explain` answers from stored
  `spam_details`; `users.preferences.spamEnabled` (default on) plus per-account `antispam_enabled`
  (default off, opt-in, settable via `PUT /api/accounts/:id` and the account form alongside
  `trusted_authserv_id`) gate automatic classification; only `contacts.is_auto = false` plus own
  addresses feed the contacts ham signal.
- Add a React Error Boundary at the entrypoint so a render-time exception shows a translated
  recovery screen with a reload action instead of a blank page.
- Add a `pageshow` persisted handler to the WebSocket wake effect so returning from BFCache reuses
  the existing refresh-and-reconnect path instead of staying silent.
- Warn before downloading attachments classified as potentially dangerous (executable, script, shortcut
  extensions and matching media types); the download still proceeds after explicit confirmation and the
  Download-all ZIP path cannot bypass the prompt.
- Mount the `SpamSettings` status/master-switch/retrain panel as a third sub-tab (Antyspam) under
  Settings → Rules, next to Rules and Block List, with a settings-search index entry and locale keys
  in all 9 locales.

### Notes

- Includes database migrations `0094_folder_uidnext_status.sql`, `0095_spam_classifier_v2.sql`,
  `0096_account_maintenance_state.sql`, `0097_spam_model_usable_counts.sql`,
  `0098_spam_training_identity.sql`, `0099_spam_identity_rederivation.sql` and
  `0100_message_spam_score_blended.sql`, applied in order;
  apply before running workers or accepting outbound mail. The antispam auto-move is opt-in per
  account (`email_accounts.antispam_enabled`, default off) behind the per-user master switch
  (`users.preferences.spamEnabled`, default on). No other configuration is required.

## [4.0.2] - 2026-09-17

### Fixed

- Apply the public calendar-feed request budget before database lookup, preventing a flood of syntactically valid unknown tokens from exhausting PostgreSQL.
- Preserve partial SMTP recipient results through post-send failures and keep a partial-send composer open
  with only rejected recipients for a safe retry.
- Prevent stale account and deep-link callbacks from writing into a later SPA session; preserve navigation only
  for the user who stored it.
- Release IMAP connection markers after every setup failure, including DNS resolution failures.
- Retire failed, timed-out and terminating calendar projection workers before draining queued work.
- Atomically claim calendar invitation outbox entries, persist partial recipient failures for targeted retry, and
  prevent overlapping drains from issuing duplicate invitations.
- Reject incomplete AI chat-completions SSE streams instead of converting upstream EOF into a synthetic success.
- Apply Microsoft integration settings exactly as saved, including clearing omitted fields at runtime.
- Detect lost idempotency-lease ownership and prevent same-process automatic duplicate sends while the SMTP
  outcome is uncertain.
- Preserve recipient header roles on partial-send retry, including BCC-only delivery; scope delayed compose and
  API-auth callbacks to their originating session.
- Store idempotent send intents durably with request fingerprints, retain ambiguous SMTP outcomes for manual
  reconciliation, and reject changed requests that reuse a key.
- Make calendar invitation delivery durable across deletes, partial failures and recovery: checkpoint accepted
  actions, retain missing-sender work, and use an atomic completion marker. Invitation requests without a client
  key now receive a server operation key and follow the outbox path.
- Fail closed for edits or cancellations of invited recurring occurrences, where a correct attendee notification
  cannot be generated.
- Keep an invitation outbox action uncertain after ambiguous SMTP or post-SMTP database loss; it is no longer
  automatically resent. Explicit SMTP rejections, including temporary 4xx failures, remain retryable.
- Snapshot autosave input so edits made while a draft request is in flight remain dirty and are saved by the next
  autosave rather than being silently treated as persisted.
- Mark calendar invitation delivery uncertain only after SMTP transport preparation succeeds; DNS, credential,
  TLS-policy and MIME preparation failures remain retryable without issuing SMTP.
- Return the persisted calendar invitation status when an idempotent retry cannot acquire its claim, preserving
  uncertain delivery warnings instead of falsely reporting active processing.
- Prevent draft-save acknowledgements from restoring newer To/CC/BCC edits or closing a composer with changes
  made while a save-and-close request was in flight.
- Keep the previous draft's account and mailbox identity through a sender-account change, preventing a UID
  collision from deleting an unrelated draft in the destination account.
- Preserve durable invitation-cancellation statuses in calendar responses and retry the same cancellation outbox
  operation instead of falsely reporting uncertain or processing delivery as sent.
- Keep calendar cancellation delivery checks separate from event edits, so reopening an event shows the durable
  status without discarding a later title, time or description change.
- Bind every destructively handled draft to its persisted UIDVALIDITY epoch, retaining the draft rather than
  deleting a reused UID after a mailbox reset.
- Preserve BCC recipients and the historical draft identity when reopening a saved draft, while discarding late
  draft-open responses after an authentication-session change.
- Clear only the completed cancellation operation's prior failure message after a successful retry.
- Preserve the selected alias, reply headers, editable body format, signature and quoted reply material when reopening drafts; reject an unavailable alias rather than silently falling back to the primary address.
- Replace every cached draft field from an authoritative APPEND snapshot, preventing UID reuse after a mailbox epoch reset from inheriting prior recipients.
- Apply the same fail-closed selected-alias validation to sending and draft saving.
- Keep each reopened draft in its saved text/HTML format through SMTP MIME generation, including HTML quotes and inline images, while preserving literal legacy API text when the format flag is absent.
- Preserve canonical plaintext signature text through draft reopen and send, including line breaks, and structurally convert legacy HTML-only signatures with block and line-break boundaries during upgrade.

### Notes

- Includes database migrations `0085_calendar_invitation_outbox_claim.sql`,
  `0086_calendar_invitation_outbox_deleted_event.sql`, `0087_send_idempotency.sql` and
  `0088_calendar_invitation_outbox_completion_checkpoint.sql`,
  `0089_calendar_invitation_outbox_uncertain_dispatch.sql`,
  `0090_calendar_cancellation_outbox_reference.sql`,
  `0091_draft_uidvalidity_identity.sql`, `0092_draft_bcc_addresses.sql` and
  `0093_draft_composition_metadata.sql`; apply migrations before running workers or
  accepting outbound mail. No new configuration is required.

## [4.0.1] - 2026-09-13

A patch release with **no new functionality**. The whole application — backend and frontend — was
migrated from JavaScript to TypeScript, and every defect the migration surfaced was fixed in the
code instead of being silenced with type-checking suppressions.

### Why this release exists

The codebase was plain JavaScript with no compiler in the loop, so a wrong property name, a missing
import, a callback the caller never passes, or a comparison that can never be true only failed at
runtime — usually only on the code path a user happened to hit, and often in a rare state.

The migration was therefore done the strict way: **no `@ts-nocheck`, no blanket `as any`, no
`@ts-ignore`**. The compiler had to be satisfied with real types and real fixes, which turned the
migration itself into an audit: the same work removed latent defects rather than hiding them.

### Changed

- **Backend and frontend sources are 100% TypeScript** — `backend/src` 312 `.ts` files and
  `frontend/src` 239 `.ts`/`.tsx` files, with **0 `.js`/`.jsx`** implementation files; Playwright
  specs and configuration are `.ts` as well.
- Both projects type-check cleanly in default strict mode (`tsc --noEmit` → 0 errors) and lint
  cleanly with `--max-warnings 0`.
- **No type-safety escape hatches remain**: 0 TypeScript suppression pragmas, 0 ESLint-disable
  pragmas and 0 explicit unsafe `any` escapes. `DbRow` is `Record<string, unknown>`, so dynamic
  SQL consumers declare or narrow every column they read.
- The backend is built with `tsc -p tsconfig.build.json` into `dist/`; `npm start` runs
  `node dist/index.js`, `npm run dev` runs `tsx watch src/index.ts`, and the Docker image
  builds and runs from `dist/`. The frontend entry is `frontend/src/main.tsx`; the Vite build
  is otherwise unchanged.
- Shared type infrastructure added: Express and session augmentations, typed `req.query` helpers,
  JSON response shapes for route tests, and the native-bridge globals.

### Fixed

Real defects found while typing the code — each is something JavaScript could not have caught:

- **An AI result component referenced `renderMarkdown` without importing it.** Every AI summary
  or custom action output would have thrown `ReferenceError: renderMarkdown is not defined`.
- **`onContextMenu` read `e.pointerType`**, which does not exist on `MouseEvent`. The guard
  meant to restrict the folder context menu to a desktop right-click was always true.
- **A test double returned an array where the production code expects a `Set`**
  (`resolveAllTrashPaths`); the caller uses `.has()`, so the wrong shape would have thrown.
- **`providerConversationMetadata` read a `references` field that `parseProviderMetadata`
  never returns** — a dead fallback that the type checker exposed.
- **`intervalMilliseconds` and `normalizeHref` returned `null`** while their contracts said
  `number`/`string`.
- **`listMessages` accepted both a quoted true string and a boolean** for `unreadOnly`
  and `threaded`; typing pinned the contract and fixed callers that passed the wrong one.
- **`computeThreadId` was called with an extra `subject` argument** its four-parameter
  signature ignored, hiding a mismatch.
- **`Date` objects were subtracted directly** in sorting and range code (for example
  `new Date(a) - new Date(b)`), which is only accidentally correct; replaced with `.getTime()`.
- **The draft and send paths passed the stream-transport message straight to `.on(...)`**, where
  the type is a union with `Buffer`; the message stream is now narrowed with a hard error.
- **Outbound-mail responses returned an `ok: true`-only shape** while the client read
  `sentCopySaved`/`sentFolder`.
- **Frontend style objects were untyped**, so `boxSizing` widened to `string` and cascaded into
  dozens of `CSSProperties` errors; the same pattern hid a missing `inert` attribute in the
  React 18 type definitions.
- Test doubles and fixtures that silently disagreed with the code they stand in for (a missing
  `verify()` on the SMTP transport double, `parseMessage` results without their required
  fields, mock return values without `rows`).
- **HTTP query parameters were treated as strings without validation.** Express can provide a
  string, an array or nested query data; shared `queryString`/`queryInt` guards now reject invalid
  shapes before they reach mail, auth and calendar services.
- **OAuth/OIDC, CardDAV, Todoist and AI provider payloads crossed the application boundary as
  unchecked values.** Each now has an explicit response/request contract and narrows external
  data before it is consumed.
- **Calendar projection and IMAP timeout promises inferred `unknown` or mixed result shapes.**
  The projection queue, provider profiles, mail append flow and sync planning now use declared
  result and option types, preventing invalid field reads and wrong callback contracts.
- **Conversation and message-action contracts disagreed across callers.** Optional copy/logical
  message identifiers, body snippets, mail options and read-state action inputs now match the
  behavior that production code implements.

- **Tailwind and the PostgreSQL workflow now follow the TypeScript migration.** Tailwind scans
  `.ts`/`.tsx` sources, while the PostgreSQL workflow invokes TypeScript scripts and test files
  through the project loader instead of deleted JavaScript paths.
- **SMTP and OAuth account handling is fail-safe.** Missing SMTP credentials return a controlled
  error; STARTTLS requires encryption; connecting Microsoft OAuth converts an existing password
  account to the correct OAuth provider.
- **Mail and calendar isolation/reliability defects are fixed.** The IMAP pool reserves slots before
  asynchronous connection work; custom-port IMAP accounts retain an explicit TLS choice; calendar
  workers retain per-request budgets and never reuse a shorter in-flight projection for a wider
  request.
- **Session and account security are preserved.** A user switch clears private mail, drafts, search,
  thread and notification state; active TOTP cannot be overwritten; directional control characters
  are removed from attachment names; explicitly cleared Microsoft settings clear the live runtime.
- **Delivery and AI policy behavior is explicit.** Partial SMTP recipient acceptance is returned to
  the caller, long sends renew ownership-checked idempotency leases, and every API-key AI request
  uses the current connection policy with a pinned, redirect-aware transport.
- **Conversation AI output is safe and usable.** It collapses with its message and renders sanitized
  Markdown, including sanitized Mermaid diagrams.

These fixes are documented here as the release record; no standalone migration report is kept at
repository root.

### Notes

- **No new features, no database migrations and no configuration changes.** Upgrading from 4.0.0 is
  a drop-in image update; no data, settings or DAV contracts are touched.
- **The dynamic SQL boundary is gone.** `backend/src/services/db.ts` no longer exports
  `type DbRow = any`; it is `Record<string, unknown>`, and the ~350 call sites that read dynamic
  rows now declare the columns they actually use. This was the single largest source of hidden
  type errors, and removing it surfaced **79 real backend findings** that `any` had been hiding.
- **Strict TypeScript is enforced by default.** The primary `tsconfig.json` in both projects
  enables `strict` and `noImplicitAny`; `npm run typecheck` and the compatibility
  `npm run typecheck:strict` command both report **0 errors** in backend and frontend. CI runs
  the strict typecheck before lint, tests and builds.
- **No type-safety escape hatches remain.** Source contains 0 TypeScript suppression pragmas,
  0 ESLint-disable pragmas and 0 explicit `any`/`as any` boundary escapes. Dynamic data is
  represented as `unknown` and narrowed at its boundary.


## [4.0.0] - 2026-09-11
This is the first release of Inboxora as a suite rather than a mail client. Inboxora began as an
independently developed fork of [MailFlow](https://github.com/maathimself/mailflow); 4.0.0 is the
point where it gained its own conversation engine, its own calendar and contacts, and DAV
endpoints.

> The exhaustive, change-by-change list against upstream MailFlow is published together with the
> release tag. This entry summarises the release by area; see
> [Release notes 4.0.0](wiki/Release-notes-4.0.0.md) for the rationale behind the major version.

### Added

- **Conversation engine** — server-side conversations, logical messages and physical copies;
  `Message-ID` identity with a fingerprint fallback; `In-Reply-To`/`References` parenting;
  provider thread mapping for Gmail (`X-GM-THRID`), Outlook (`Thread-Index`) and generic IMAP;
  manual merge, split, move, lock, include and exclude overrides; threading diagnostics; per
  account rebuild with dry-run mode.
- **Threaded list and conversation reader** — two independent preferences, inline thread
  expansion, lazy body loading, quote folding, per-copy actions with scope selection and
  per-copy read state.
- **Calendar** — local writable calendars; month, week, work-week and agenda views; day agenda;
  server-side recurrence expansion with exceptions and time zones; rich event descriptions;
  invitations sent by email with sequences, cancellations, idempotency and retry; invitations
  received by mail added to a calendar without an RSVP; generated Contact dates calendar;
  anonymous read-only `.ics` feed links.
- **External calendars** — read-only CalDAV and ICS/webcal sources with encrypted credentials,
  independent sync schedules and per-source status.
- **Contacts** — multiple address books, rich vCard fields, Google CSV import, Google CSV /
  Outlook CSV / vCard 3.0 export, contact dates without a year, search and pagination.
- **DAV** — CardDAV and CalDAV servers with `.well-known` discovery, ETag/If-Match conflict
  handling, sync tokens with tombstones and stable resource filenames; a remote CardDAV client;
  revocable DAV **application passwords** for devices.
- **Interface** — the Ink-based shell with resizable panels shared across Mail, Contacts and
  Calendar, compact mode, a phone layout with drawer navigation, floating actions, safe-area
  handling and prioritised system Back behaviour.
- **Platform** — installable PWA with an unread badge and Web Push; a Windows Electron desktop
  application; a native Android/Capacitor application with instant notifications through a bundled
  **ntfy** (UnifiedPush) server in the same Docker stack, with a WorkManager reconciliation
  fallback and local notification actions (Open, Reply, Delete, Star).
- **Settings** — a rebuilt settings surface with a DAV access tab, calendar defaults, nine
  interface languages, more themes, font pairings and a font-size scale.

### Changed

- Mail accounts support aliases, per-alias signatures, folder-role mappings with auto-detect and
  per-account unified-inbox inclusion.
- Sending is idempotent, distinguishes a failed Sent copy from a failed send, and reports
  actionable SMTP errors.
- Remote images are blocked by default with an explicit address/domain allow-list.
- Search, unread counts, rules and notifications were reworked around the unified inbox.

### Fixed

- Gmail thread alignment and live unread/push delivery.
- Calendar invitation delivery and retry, including cancelled and superseded invitations.
- DAV field mapping, resource filenames, sync tokens and conflict handling.
- Mobile Back handling, panel widths and calendar responsiveness.
- Mail reliability under sync failures and interrupted responses.

### Security

- DAV endpoints authenticate with dedicated, revocable application passwords only.
- Mail, DAV and calendar credentials are encrypted at rest with `ENCRYPTION_KEY`.
- Server connection policy gates private hosts, insecure TLS and non-standard ports.
- Message HTML renders without scripts in a sandboxed frame, with double sanitisation.

### Migration notes

- Database migrations run automatically on backend start.
- Existing preferences and legacy storage identifiers are preserved; the retained identifiers are
  documented in [`docs/technical-identifier-audit.md`](technical-identifier-audit.md).
- Threading is disabled by default, so an upgrade does not change how existing mail is displayed.
- **MailFlow 3.3.0 deployments can migrate in place without losing data.** The 50 schema
  migrations MailFlow 3.3.0 ships are byte-for-byte identical here, and this release only adds
  migrations on top. Only MailFlow 3.3.0 is a supported migration source; newer versions have not
  been tested. Keep `ENCRYPTION_KEY`, `DB_NAME` and `DB_USER`, note that `MAILFLOW_VERSION` became
  `INBOXORA_VERSION`, and follow
  [Migrating from MailFlow](wiki/Migrating-from-MailFlow.md).

### Additional 4.0.0 changes

#### Added

- **Separate light and dark theme defaults** — choose the theme used in the light appearance and
  the theme used in the dark appearance independently, and select a theme mode that follows the
  system colour scheme or forces light/dark. **Ink** is the default light theme and the new
  **Dark ink** is the default dark theme, so a fresh profile follows the system out of the box.
  A single theme chosen before this change is preserved as an explicit choice for its appearance.

- **Calendar subscriptions from Settings** — the Calendar settings tab now has a **Calendar
  subscriptions** section where an ICS/webcal feed is added by URL, next to a **Public holidays**
  picker that subscribes to the matching Thunderbird holiday calendar for a country. Inboxora still
  keeps no holiday data of its own: the country only selects the URL of the maintained read-only
  feed, which the normal external-calendar sync then pulls. See
  [External calendars](wiki/External-calendars.md).

#### Fixed

- **All-day and multi-day events stretch across the day in the week grids.** They were drawn as
  small chips in a thin row above the time grid; they now fill the full height of every day they
  cover, side by side when several overlap, and a multi-day event joins across the day columns
  instead of restarting in each one.

- **Message bodies no longer render black on dark.** An HTML mail is displayed in its own
  sandboxed document, which cannot inherit the app's colour tokens; its default text colour
  followed the operating system, so a message that declared no colours of its own was painted
  black on the dark appearance. The frame now declares the theme's colour scheme and, in a dark
  appearance, the surface and text colour it actually uses.
- **A message is adapted to the dark appearance instead of being repainted.** Deciding the
  reading canvas from "does this message declare any colours of its own?" was far too blunt:
  virtually every real message contains at least one dark colour (a footer, a legal line), so a
  dark theme rendered every message on a white page. The canvas now always follows the theme, and
  only the declarations that would be unreadable are adjusted — dark text on the dark surface is
  lifted to a readable light colour, and content inside a card the message painted itself gains a
  dark text colour so the theme's light default cannot land on it. Hue and saturation are
  preserved, so a muted footer stays muted. A message's own light panels are kept, because that
  is what its author intended.
- **A retracted invitation can be withdrawn from the calendar.** Cancelling an event in the mail
  reader previously only reported the cancellation. The panel now offers to remove the copy the
  message created, and refuses to remove an event the user has since taken ownership of or a
  cancellation older than the copy on file.

#### Changed

- **The mail-invitation panel is a compact action row.** It carries the date, the calendar and
  the action only; the title, location and description are no longer duplicated inside it, since
  the message already shows them above and below. Invitations already added report that state
  instead of offering to add them a second time.
- **External calendar sync cadence is editable per calendar.** The interval was already stored
  per source and defaulted to 60 minutes, but was neither surfaced nor changeable after creation;
  it can now be set from the source list (15 minutes to 24 hours).
- **The phone week grid opens on today and pans smoothly.** Week and work-week views are wider
  than a phone screen and previously opened on the first day of the week, hiding today behind a
  sideways swipe. They now open with today centred (or the selected day when today is not in
  view), and the grid scrolls in both directions from a single container — the nested pair of
  scrollers it used before made every horizontal swipe hand off between two elements and stutter.
- **Address books can be renamed.** The API already accepted a rename, but nothing in the
  interface reached it, so a book was stuck with the name it was created or imported under. The
  book menu now offers **Rename**, and creating a book uses the app's own dialog instead of a
  native browser prompt.
- **Standalone dropdowns match the interface.** A `select` placed outside a form — the calendar
  picker on a mail invitation, the external-calendar sync interval — rendered as raw platform
  chrome. They now share one themed control with the app's own arrow and focus ring.

#### Performance

- **Recurring events are now expanded ahead of time instead of while you wait.** A series has to
  be walked from its own start date — re-seeding the rule iterator at the requested window is not
  equivalent, and that was verified against the library rather than assumed. Measured at ~10-20 µs
  per occurrence, a daily series running since 2018 takes ~50-90 ms *every* time it is expanded, so
  a work calendar with twenty such series spent ~750 ms of CPU per cold view and forty spent
  ~1.4 s. Caching could remove the repetition but never the walk, which is why the first view of
  each month stayed slow. Occurrences are now materialised into a table in the background and a
  read is an indexed range scan: the same week went from ~745 ms of expansion to **3.5 ms**, with
  the query plan confirming a `Bitmap Index Scan` on the range index (0.14 ms execution). An event
  that has not been rebuilt yet is expanded on the fly exactly as before, so a lagging or failing
  worker makes the calendar slower — never missing an event. Any write marks its series for rebuild
  through a database trigger, which covers all eleven write paths including CalDAV and the external
  sync without depending on each one remembering to. See migration `0083`. The expansion runs
  on the projection worker pool, not the background thread: the first version expanded inline and
  froze the API, holding the event loop for the whole 429 ms of a four-series batch with zero
  timer samples recorded, against 5-7 ms through the pool.
- **The calendar no longer scans every event to find recurring ones.** The read paths selected
  "events in this window, plus every recurring series" and expressed the second half as a regular
  expression over the iCalendar body. No index can satisfy a regex over an unindexed column, so
  the database scanned every event the user owned and decompressed each body: measured on 20,000
  events this was a sequential scan that discarded all 20,000 rows and cost ~131 ms, before any
  recurrence was expanded, growing with mailbox age. Recurrence is now a stored, trigger-maintained
  column with partial indexes; the planner uses a BitmapOr of the range and recurrence indexes and
  the same query costs ~3 ms.
- **Expanded occurrences are cached for 30 minutes instead of 5.** Because the cache key carries
  the event's version, an edit invalidates its own entry immediately — the TTL only bounds memory.
  At five minutes, opening the calendar after any pause was a cold cache and re-expanded every
  series from its original start.
- **A failed expansion is cached briefly** (30 seconds) rather than not at all. A series that
  overran its iteration budget was previously re-expanded on every single request.
- **Expanded occurrences are now cached per calendar month, not per requested window.** A
  recurring series must be walked from its original start — re-seeding the rule iterator at the
  window start silently changes the occurrences for most rules, and that was verified against the
  library rather than assumed. Costing ~10-20 µs per occurrence, a daily series running since
  2015 takes ~50 ms to expand, so a calendar whose series are old paid that walk again for every
  window: opening the month grid, stepping a week, switching to the agenda and coming back each
  cost a fresh walk. Measured over a realistic session with 25 such series, the total fell from
  **2093 ms to 435 ms** — every view of a month after the first is now free — while the *first*
  open is unchanged (429 ms → 434 ms). A wider cache (a whole year, or a quarter) was tried and
  rejected: it made the first open slower by emitting months of occurrences the view never
  displayed.
- The contact-calendar and appearance reads now run concurrently instead of one after the other,
  on a path that is active by default.

#### Added

- **Deleting an event that belongs to a series now asks which part of it you mean**, because the
  three answers produce three genuinely different calendars: only that occurrence, that occurrence
  and every following one, or the entire series. Before this the interface could only ever remove a
  single occurrence — there was no way to delete a whole series at all, and none to stop one from a
  given date onward.
- "This and every following occurrence" is written by **ending the series' rule** (`UNTIL` set just
  before the chosen occurrence, with any later exceptions dropped). Cancelling from a series' first
  occurrence removes the event rather than leaving a series that produces nothing. Truncating the
  rule is what other calendars write for this operation, so the result stays portable between
  clients.
  - The obvious alternative was measured and rejected: an exception carrying
    `RECURRENCE-ID;RANGE=THISANDFUTURE` with `STATUS:CANCELLED` **left the series completely
    unchanged**. `RANGE=THISANDFUTURE` in this library exists to *reschedule* the remainder of a
    series — moving one occurrence to 14:00 moved every later one, which is correct — but a
    cancelled range exception is not a deletion. An earlier revision of this changelog claimed the
    library honoured that semantics; that claim was wrong.

#### Known limitations

- **Browsing outside the materialised range falls back to expanding on the fly.** Occurrences are
  materialised from three months back to eighteen months ahead. Outside that, and for the few
  seconds between saving an event and the background rebuild, events are still expanded from their
  series start, which is slower for series that began years ago. The range is configurable with
  `CALENDAR_OCCURRENCE_HORIZON_*`; widening it costs database rows (a daily series is ~365 rows per
  year of range), so it is a deliberate trade rather than a fixed constant.
- **Cancelling part of an invited series does not notify attendees.** Removing a single occurrence
  or ending a series from a date changes only the local copy; the iTIP `CANCEL` message is sent for
  a whole-event delete only. Attendees keep the occurrence until the organiser's calendar says
  otherwise.

## [3.4.0]

The upstream-era release line that 4.0.0 supersedes. See the git history for changes before this
changelog existed.
