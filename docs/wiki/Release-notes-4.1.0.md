# Release notes 4.1.0

**Status:** prepared on `dev`, **not released** — a version is released when `dev` is merged to `main`
· **Previous version:** 4.0.4 · **Type:** minor

4.1.0 adds a **native provider layer** and redesigns the send/attachment limits around the transport that
actually sends. A Microsoft account can run its mailbox, calendars and contacts over **Microsoft Graph**;
a Google account can use the **Gmail, Calendar and People APIs**; every account that prefers it keeps
working over plain IMAP/SMTP, including Google with an app password. Provider data can be written back to
its source, and an existing Microsoft account is moved to Graph **in place**, without a second account and
without copying or losing anything local.

## Highlights

- **Native Microsoft Graph mail, calendars and contacts.** Reading, filing, flagging, searching, drafting
  and **sending** over Graph, with folders, delta sync, bodies and attachments (single, inline and ZIP),
  delete, move/archive, spam/ham, snooze, bulk delete, mark-all-read, source headers, drafts and
  provider-side search. An account that runs over Graph never opens an IMAP or SMTP connection, including
  the health checks, the IMAP loops and the automated rule forwarder.
- **An existing Microsoft account moves to Graph in place.** `POST /api/accounts/:id/migrate` keeps the
  **same account row** — no duplicate, nothing local copied, lost or renamed — and there is no fallback to
  Microsoft IMAP/SMTP once it is native.
- **The Gmail API as an optional transport for Google mail**, recommended but never forced: labels,
  history-cursor ingest, bodies and attachments on demand, message mutations, drafts and sending, with
  Google mail still fully supported over IMAP/SMTP with an app password.
- **Google Calendar and Google Contacts over the API**, with read/write collections once write-back is
  enabled per collection.
- **Instant synchronisation, with polling as the safety net.** Microsoft Graph change notifications, Gmail's
  `watch`/Pub/Sub push and Google Calendar push channels shorten the delay between a change at the provider
  and its appearance in Inboxora. They are an accelerator: every notification runs the existing delta/history/
  sync-token sync, the schedule still refreshes every pulled collection, and an administration whose callback
  URL is unreachable keeps working exactly as before. Push needs a public HTTPS URL (derived from `APP_URL`)
  and, for Gmail, a Cloud Pub/Sub topic; the provider cards report the state per connection.
- **An existing Google mailbox can move to the Gmail API without being recreated.** The account keeps its id
  and every piece of its local data, exactly one account remains, and the switch is atomic and repeatable. The
  recommendation in the account settings now performs that migration, including the Gmail authorization when
  the mailbox does not have it yet; the IMAP/SMTP app-password setup keeps working whether or not you migrate,
  and Inboxora never falls back to IMAP after a successful switch.
- **DAV write-back, from Inboxora or a DAV client.** A calendar or address book imported from an external
  CalDAV/CardDAV server can be edited in Inboxora's own calendar or contacts page **and** from a DAV client,
  and the change is forwarded to that server — create, update, delete, recurring series and all three
  occurrence scopes. A provider collection (Graph or Google) is written over the web interface, and
  per-collection write-back is an explicit opt-in taken from the calendar sidebar or the address-book menu.
- **Recurring events can be changed for one occurrence, for this-and-following, or for the whole series** —
  in a local calendar, a Google calendar, a Microsoft Graph calendar and a write-enabled CalDAV collection.
  "This and following" truncates the series at the split and, when you edited it, continues the rest as a new
  series that keeps the attendees. An invited series behaves the same way: cancelling or moving one occurrence
  notifies the attendees with the matching iTIP message (`RECURRENCE-ID` and an advanced sequence), and Google
  and Microsoft notify them themselves when the change is made there.
- **Send and attachment limits that follow the transport**, so a large file on a Microsoft Graph account
  travels through a resumable upload instead of being refused by another transport's ceiling.
- **The menu-follows-your-finger mobile drawer gesture**, with arbitration against scrolling, long-press
  and row actions.
- **A hardened CalDAV/CardDAV server**: strong entity-tags, per-collection visibility and access modes, a
  per-password ceiling that can only narrow access, `DAV:error` bodies and correct sync-token handling.

## Upgrade impact

- **Apply migrations `0101`–`0112` in order, before rolling out the application.** They are additive and no
  existing table, column or row is rewritten. Three deserve naming: `0110` adds the columns the Microsoft
  device authorization uses and must be applied before a device flow is started; `0111` adds the nullable
  `messages.provider_labels` the Gmail adapter writes; `0112` adds the `read_write` value the per-collection
  write-back switch needs and changes no row, so nothing becomes writable because of it. An application
  version older than these columns simply leaves them `NULL`.
- **Microsoft accounts are not migrated automatically.** An existing Microsoft account keeps reading and
  sending over OAuth2 IMAP/SMTP until an administrator (or the account's owner) invokes the in-place
  cutover for it. Migrating is what makes the Graph paths reachable for that mailbox; **no account is
  created, duplicated or deleted by the migration**.
- **Google accounts are not migrated automatically either.** IMAP/SMTP with an app password continues to
  work and is a supported long-term choice; the API is **recommended** in the accounts settings, and
  *Ignore* or *do not show again* dismisses the recommendation (the latter durably, per user and per
  mailbox).
- **Recurring events and per-occurrence edits work in every writable calendar**, and a write-enabled
  CalDAV/CardDAV collection is editable from Inboxora's own pages as well as from a DAV client — no
  configuration change is needed for either.
- **Nothing is deleted by an upgrade.** Imported data, mail, rules, aliases, signatures, preferences and
  DAV application passwords are untouched; the only deletion paths remain explicit and owner-scoped.
- **Provider configuration is optional.** With no provider configured, mail, contacts, calendars and DAV
  behave as in 4.0.4. The layer can be disabled installation-wide with `PROVIDER_INTEGRATIONS_ENABLED=0`.
- New optional configuration: `MAIL_MAX_MESSAGE_BYTES` (the **fallback** ceiling for a transport that
  declares none, i.e. SMTP) and `MAIL_MAX_ATTACHMENT_BYTES` (the **hard** installation ceiling on one
  attachment and on their total). Neither raises a provider's own limit, and leaving them unset does not
  cap Microsoft Graph.

## Administrator actions

The full procedure — fields, redirect URIs, scope names and console steps — is in
[Connecting Google and Microsoft accounts](Provider-setup.md). In summary:

- **Entra application (Microsoft).** Register one application and add the Graph **delegated** permissions
  the features you enable need: `Mail.ReadWrite` and `Mail.Send` for the mailbox, `Calendars.ReadWrite` for
  calendars, `Contacts.ReadWrite` for contacts (the read-only variants are requested when a read-only
  connection is chosen). Add `User.Read`, which identifies the account being authorized. Then:
  - **browser method** — a client secret plus the callback `MS_REDIRECT_URI` for mailbox sign-in and
    `MS_PROVIDER_REDIRECT_URI` for the Graph connector (derived from `APP_URL` when unset);
  - **device-code method** — the **Client ID alone**, with *Allow public client flows* enabled on the
    registration; no secret and no callback. The device flow is independently switchable per method, and
    the Graph connector supports it too.
  - Both methods can be configured together; each has its own readiness, and switching one off is enforced.
- **Google Cloud project (Google).** Create a project, enable the **Gmail**, **Google Calendar** and
  **People** APIs you intend to use, configure the OAuth consent screen, and create a **Web application**
  OAuth client with the redirect URI `GOOGLE_REDIRECT_URI`. The scopes requested are `gmail.modify` for
  mail, `calendar.calendarlist.readonly` plus `calendar.events` (or `calendar.events.readonly` for a
  read-only connection) for calendars, and `contacts` (or `contacts.readonly`) for contacts. While the
  consent screen is in **Testing**, only listed test users can authorize; publish it or add your users
  before expecting a user to connect.
  - **There is no Google device-code option** and none is offered: Google's limited-input device flow does
    not carry the Gmail, Calendar or People scopes. A user authorizes through the browser.
- **Per-method readiness distinguishes "configured" from "working".** The provider cards report which
  values are present per method; a mistyped secret reads as ready until an authorization fails at the
  provider, so verify with one real connection after configuring.
- **Turn the layer or a method off** per installation, per provider or per method — including
  `PROVIDER_INTEGRATIONS_ENABLED=0`, which stops the authorization flows and the sync paths.

## Upgrade from 4.0.4

**No manual SQL is needed.** The upgrade runs when the backend starts, exactly as any previous release's did.

One migration had to be corrected for existing installations. `0108` created a unique index on
`messages (account_id, provider_message_id)` on the assumption that the column had always been the native
provider identity. It had not: it came from Conversation Engine v2 as threading evidence, and on a Gmail IMAP
mailbox it holds X-GM-MSGID — an identifier that is mailbox-wide, so the same message legitimately has the
same value in every folder/label copy (INBOX, `[Gmail]/Important`, `[Gmail]/All Mail`, custom labels) because
moving or copying a message preserves it. On a real mailbox (19 231 rows, 7 445 distinct values) the index
could not be created and the backend stopped at that migration.

The corrected migration clears that column **only for accounts whose transport is the legacy one**
(`mail_transport` NULL or `imap_smtp`) before it creates the index, and leaves it alone for accounts already
on a native transport. Nothing else changes: **no message row is deleted**, and every id, `uid`, `folder`,
`message_id`, `thread_key`, `provider_thread_id` (X-GM-THRID) and Conversation Engine value is preserved, so
existing conversations, rules, snoozes and plugin links are untouched and Gmail threading keeps working.

Three states are handled without intervention: a 4.0.4 database (0108 never applied), a `dev` database that
already applied the first revision of 0108 (its recorded checksum is accepted, so it keeps booting), and a
database whose 0108 attempt stopped after adding the column (the corrected migration runs from there).

Two states are covered beyond the clean upgrade, because an installation may have run an earlier `dev`
build:

* a database whose `0108` attempt stopped after adding the column — the corrected migration runs from there;
* a database that already applied the **first** revision of `0108` (its recorded checksum is accepted, so the
  corrected file is deliberately not re-run) and therefore still holds legacy provider ids while the unique
  index exists. Migration **`0114`** applies the same normalisation unconditionally, so a later IMAP copy or a
  new Gmail label cannot collide with the index; on a clean 4.0.4 upgrade it is a no-op.

> Upgrade from 4.0.4 databases containing legacy Gmail IMAP folder copies is covered by an integration test.

## Where provider configuration happens, and where accounts do

**Integrations configure provider applications. Accounts connect individual mailboxes.** This is the rule the
settings are organised by:

- **Settings → Integrations** (administrator) holds the Microsoft Entra and Google Cloud OAuth clients — client
  id, tenant, secret, redirect URI — the browser/device-code readiness, the scopes each authorization asks for,
  the push/webhook/Pub-Sub configuration, the configuration test and the aggregate diagnostics. **It starts no
  authorization at all**: no mailbox sign-in, no Graph connector, no device-code connect, no Google
  calendar/contacts connect, no per-user connection list and no per-connection push switch. Those actions
  belong to the mailbox they authorize and live on its card.
- **Settings → Accounts** (user) is where a mailbox is added: **Add account** offers Microsoft, Google or
  another provider over IMAP/SMTP, next to the existing accounts and their migration, reconnect, aliases,
  folders, reindex and removal.

A Microsoft or Google mailbox added there signs in with the provider and is created **natively** (Microsoft
Graph, or the Gmail API) with the address the provider reports — no host, port or password is typed, and no
IMAP account is created first. Gmail over IMAP/SMTP with an app password stays a supported choice on the same
screen, labelled as such. When the administrator has not configured a provider yet, the screen says so and
links to Integrations. A mailbox that is already added over IMAP is not added twice: Inboxora reports it and
offers the migration to the native transport.

## Managing address books, and diagnosing a provider

**Settings → Contacts → Manage address books** opens a panel: the books on the left with their source, visibility
and read/write state, and the selected book's settings on the right — general, synchronisation, write-back, DAV,
import/export (Google CSV, Outlook CSV, vCard) and a danger zone. A book a provider owns is not a local book: it
cannot be renamed, imported into or deleted from here, and the last local book is protected. On a phone the same
panel opens as a sheet, with the list first and a Back action from the details. Provider authorization is
deliberately absent from this panel: connecting Google or Microsoft contacts remains an account action
(Settings → Accounts → the mailbox → Contacts).

**A failed synchronisation now says why.** Instead of a failure count, the first concrete reason is shown — a
missing scope names the scope and the service to reconnect, an authorization the provider refused shows its
code, a rate limit asks for patience, and a provider error shows its HTTP status, with the number of further
failures when there were several. A synchronisation the grant cannot authorize is refused before the provider is
called.

**Each account has a Diagnostics section** (collapsed by default) on its provider-services card: the connection
and its status, and per feature whether it is authorized, which scopes are missing, when it last succeeded, its
last error code, whether a cursor exists, and its push and schedule state. It contains no token, secret or
provider payload.

## Known limitations

- **Names already stored with replacement characters are not rewritten.** The fix applies when a header is
  decoded, so newly received mail is correct. A message that was already parsed under the old decoder holds the
  replacement character in the database, and the original octets are not recoverable from it — re-fetching or
  re-parsing that message (a re-sync, or reopening it from the provider) is what repairs it. Nothing else is
  affected, and no manual database work is required.

Deliberate product behaviour, not missing work:

- a **provider collection is written over the web interface**; over DAV it stays read-only, because the DAV
  server forwards a write only to an external CalDAV/CardDAV source;
- an **ICS subscription** is read-only at its source and can never be written back;
- **push-assisted synchronisation needs a reachable HTTPS endpoint**: without a public `APP_URL` (or with
  `PROVIDER_PUSH_ENABLED` off) Inboxora synchronises by polling alone, which is the supported default;
- **Google Contacts stays polling-only**: the People API has no push channel for the contact resources
  Inboxora syncs, so its sync token and the schedule remain the mechanism;
- **Google personal contacts only**, no shared directory, and no remote creation or sharing of collections;
- a **legacy external CalDAV/CardDAV collection** gains its write-back link on the next sync of its source
  rather than through a one-shot migration;
- **invitations are Inboxora's on a CalDAV collection**: a plain CalDAV server is not a scheduling service, so
  an event with attendees created in such a collection is mailed by Inboxora rather than by the source.

## Manual acceptance not run

These need a real provider, device or client. They are **NOT RUN**, not failures:

- **live Microsoft** — authorization (browser and device code), Graph mail, calendars, contacts, send and
  provider-side search against a real mailbox;
- **live Google** — OAuth, the Gmail API, Calendar and People;
- **a real mailbox cutover** from IMAP/SMTP to Graph or the Gmail API;
- **DAV clients** — DAVx⁵, Thunderbird and macOS Contacts/Calendar, including write-back;
- **the browser suite and documentation screenshots** for this revision on a runner, and the **CI jobs on a
  GitHub runner** (every command was run by hand against a real PostgreSQL);
- **a real touch device** for the drawer gesture.

## Verification

Measured on the frozen `dev` SHA **`561262b4cb3b554fb8e9a2821224d49ee7206f36`**, with each gate's own exit
status read rather than inferred from a pipeline:

- Backend: typecheck clean, lint clean, **2983 unit tests passed, 225 skipped** (247 files passed, 25
  skipped).
- Frontend: typecheck clean, lint clean, **2779 tests passed, 0 failed**, production build clean.
- Database: a database created empty for the purpose, the **whole 116-migration chain applied from zero**
  by the application's own runner, then **425 integration tests across 47 suites** on PostgreSQL 16 —
  exit 0. (Running the unit suite *and* the integration suites against one database in a single process is
  not a supported combination: independent integration files then contend on the same conversation tables
  and a `SERIALIZABLE` rebuild can hit a serialization failure. The two figures above are the separate,
  supported invocations.)

**Images published from that exact SHA** (documentation-only commits follow it, so the published images are
the current `dev` code). Workflow run
[`35524144582`](https://github.com/Dragonk/Inboxora/actions/runs/35524144582) built and pushed the `:dev` tags
from `561262b4cb3b`; both resolve to OCI image indexes carrying `linux/amd64` **and** `linux/arm64`:

- `ghcr.io/dragonk/inboxora-backend:dev` — `sha256:f99fbb892b2adf600186474a12166aadfc8a504b6879ef5924466c09e97c9f46`
- `ghcr.io/dragonk/inboxora-frontend:dev` — `sha256:88ea7c949c816f14d590c4ff8ad582992719ab8f06a58a49d4b5dd45a36809fc`

**Runtime smoke of that published pair — RUN, and passed.** The pair was pulled and started as a stack
(PostgreSQL, Redis, ntfy, backend, frontend) from a fresh volume: the backend applied the migration chain
and became healthy, `/api/health` answered `{"status":"ok"}`, **`/api/version` answered
`{"version":"dev","sha":"561262b4cb3b554fb8e9a2821224d49ee7206f36"}`** — the published image is the frozen
revision — `schema_migrations` held all **117** rows, the first user was registered (admin), a fresh cookie
jar logged in through `POST /api/auth/login`, `/api/auth/me` returned that user, `/api/accounts` returned
`[]`, and the UI root served the application. `docker inspect` reported **0 restarts** for every container
and no migration failed.

**Not run for this revision, and therefore NOT RUN rather than passing:** the manual acceptance list above,
the browser suite and screenshots for this revision, and the CI jobs on a GitHub runner. The live-provider
paths are exercised against faked providers at the HTTP boundary and a real PostgreSQL; no real Google or
Microsoft application is registered in this environment.

## Detailed changes

### Fixed

- **A synchronisation that was taken over can no longer write over the newer one.** When a run lost its lease
  while waiting on the network and another worker took over, it could still store its page; only the cursor was
  protected. Every page is now written inside a transaction that re-checks ownership and locks the row first, so
  the superseded run stops instead of overwriting. The provider request itself is never made while holding a
  lock.

- **An unconfirmed send can no longer turn into a silent duplicate.** Inboxora could not tell two replies with
  the same text to different messages apart when checking an idempotency key, so the second could be treated as
  a repeat of the first; and after a send whose answer was lost, the composer forgot its key, so the next
  ordinary click started a fresh send. The answered message is now part of the identity check, and after an
  unconfirmed send the key is kept — clicking Send again shows the same "result unknown" state instead of
  sending a second copy. Sending another copy anyway is a separate action that asks first and says why.

- **A throttled mailbox no longer holds up the rest.** The scheduler used one installation-wide backoff, so a
  single rate-limited collection delayed every other account and provider, and even a second worker refreshing
  the same collection triggered it. Backoff is now per collection and follows the provider's own Retry-After,
  and "another worker is already doing this" is reported as exactly that instead of as throttling.

- **Google contacts deleted while a sync token had expired are gone for good.** Google reports an out-of-date
  token in a structured field that Inboxora did not read, so the rebuild it asks for could be missed; and the
  rebuild only added what it found, so a contact deleted in the meantime stayed in the address book. The signal
  is now honoured whatever status carries it, and a completed rebuild removes the contacts it no longer lists —
  only in that address book, and only after a complete scan.

- **Moving a mail between folders keeps it.** Microsoft reports a folder delta removal both when a message is
  deleted and when it merely moves to another folder; Inboxora deleted the message from the whole account, so a
  message that had just been moved could vanish locally. The removal is now applied only to the folder it came
  from, so a move ends with the message in its new folder whichever side is processed first.

- **Microsoft contacts synchronise again, and keep your anniversaries.** The contact request asked Graph for an
  `anniversary` property that the v1.0 API does not have (and the beta API names differently), which can fail
  the whole request. It is no longer requested, and a provider sync no longer clears an anniversary you or
  another source stored. Message priority chosen in the composer is also carried over to Microsoft mail now,
  instead of silently arriving as normal.

- **A calendar you switched off is really off.** Both calendar syncs ignored the per-collection enabled switch
  when choosing what to pull, so a disabled calendar kept being synchronised, and a refresh could turn a
  collection you disabled back on. Discovery now updates only the provider's own facts, the synchroniser reads
  only enabled collections, and a share whose write permission has been revoked is shown as read-only again.

- **A synchronisation that was cut short no longer looks finished, and never deletes what it did not read.**
  Provider listings are capped at a number of pages per run. When a run hit that cap, some adapters reconciled
  deletions against the pages they had seen — deleting messages, contacts and events that were merely further
  down the list — and the contact syncs reported success for a book they had read only halfway. A capped run is
  now reported as incomplete, leaves the stored cursor alone and deletes nothing; the next run continues from
  that cursor. A Gmail baseline that was interrupted mid-page also re-reads that page rather than skipping to the
  next one, and a Gmail history feed that was too long to read to its end rebuilds from a baseline instead of
  advancing past the unread changes.

- **A duplicate name no longer loses a whole synchronisation.** When a second provider calendar, address book
  or mailbox folder had a name a local one already used, the code retried with a suffix — but the retry ran
  inside a transaction PostgreSQL had already aborted, so it failed and the discovery was lost. Each attempt now
  runs in its own savepoint, so the retry works and both collections are created and linked.

- **A partly failed synchronisation no longer looks successful.** A calendar run that could read some calendars
  but not others reported the failure in its result rather than by throwing, and the post-authorization step
  looked only for a thrown error — so the account card said the connection was synchronised when a calendar had
  not been pulled at all. A reported collection failure now makes the result a partial failure with the
  provider's code, and a failure that arrives after an earlier good run is shown instead of the older green
  state.

- **An interrupted synchronisation no longer looks finished, and a stale sync cursor is really dropped.**
  Storing progress and declaring success were the same database write, so a first synchronisation cut short
  after one page reported the mailbox as up to date; and because the cursor was written with a "keep the old
  value if the new one is null" rule, the recovery path that means to discard a cursor the provider has
  invalidated kept using it. Progress checkpoints and run completion are now separate operations with explicit
  semantics, and only a run that applied its whole declared scope is recorded as successful.

- **The account card tells the truth about calendars and contacts.** Calendar and address-book synchronisation
  state is stored per collection with no account id, and the calendar pipeline is recorded as `calendars`; the
  diagnostics looked for it by account id and under the name `calendar`, so it was invisible and the card said
  "last synchronisation: never" for a connection that had pulled data. The same screen counted every collection
  of the connection as a calendar (folders included) and compared the address-book kind to a value the schema
  does not use, so it always showed zero books. Both reads now follow how the data is actually stored, and the
  pipeline name shown follows the provider (Gmail `history`, Graph `messages`).

- **Microsoft mail synchronisation reads the folder tree again.** Folder discovery asked the pinned v1.0 Graph
  endpoint for `wellKnownName`, a property that only the beta resource has. Depending on the service that either
  fails the request outright or returns folders with no role at all, in which case Inbox, Sent, Trash, Spam and
  Drafts were not recognised and no provider message could be placed in the local folders the interface and the
  rules read. Discovery now asks v1.0 only for v1.0 fields and resolves each well-known folder through its
  documented v1.0 alias (`GET /me/mailFolders/inbox`), so a renamed or non-English folder keeps its role.

- **Reconnecting a mailbox now reaches the end of the flow.** The account card's connect button asks for one
  consent that covers mail, calendar and contacts together, but the OAuth start routes accepted a narrower set
  of purposes and quietly downgraded the request to a "new account" authorization. That authorization stores the
  token and stops: no first synchronisation runs, and the result does not name the mailbox, so the card that
  started the flow cannot match it and keeps waiting. Both providers (browser and device flow) now share one
  purpose list, a purpose that is not recognised is refused with `400` rather than turned into a different flow,
  and migration `0115_oauth_account_enable_purpose` widens the database constraint that rejected the value.
  Apply the migration before rolling out the new backend.

- **A reconnect cannot attach the wrong provider account.** Choosing a different account in the provider's
  consent window no longer re-points the mailbox at that account's token: the callback compares the identity the
  provider returned (issuer, subject and, for Microsoft, the tenant) with the identity the mailbox is already
  bound to, and refuses a mismatch with a message that says so. Same-identity re-authorizations, including a
  renamed or aliased address, continue to work.

- **A repeated OAuth callback is honest about its state.** When the one-time state has already been consumed the
  callback no longer treats "still exchanging the code" as success; a finished flow reports its terminal result,
  an in-progress one reports that it is still in progress.

- **Polish and other non-ASCII sender names from legacy charsets are shown correctly.** A message whose client
  encoded the `From`/`To` name or the subject in ISO-8859-2 or Windows-1250 — Outlook's charset for Polish — was
  decoded as UTF-8, which turned `Kamil Maciąg` into `Kamil Maci?g`; only UTF-8 mail was right, so the problem
  appeared to come and go. The charset declared in the encoded word is now used, an unknown label degrades to a
  byte-for-byte single-byte mapping rather than to a second UTF-8 decode, and the address, subject and
  list-unsubscribe paths that share the decoder all benefit.

The area-by-area list — every feature, change, fix and security note — is in
[`docs/CHANGELOG.md`](../CHANGELOG.md) under `[4.1.0]`. The per-package delivery status, the frozen code SHA
and the manual acceptance that remains are recorded in
[`docs/IMPLEMENTATION-STATUS.md`](../IMPLEMENTATION-STATUS.md).
