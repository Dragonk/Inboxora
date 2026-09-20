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
