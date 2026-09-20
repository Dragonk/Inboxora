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
  the push/webhook/Pub-Sub configuration and the configuration test. It no longer starts a sign-in for a
  mailbox.
- **Settings → Accounts** (user) is where a mailbox is added: **Add account** offers Microsoft, Google or
  another provider over IMAP/SMTP, next to the existing accounts and their migration, reconnect, aliases,
  folders, reindex and removal.

A Microsoft or Google mailbox added there signs in with the provider and is created **natively** (Microsoft
Graph, or the Gmail API) with the address the provider reports — no host, port or password is typed, and no
IMAP account is created first. Gmail over IMAP/SMTP with an app password stays a supported choice on the same
screen, labelled as such. When the administrator has not configured a provider yet, the screen says so and
links to Integrations. A mailbox that is already added over IMAP is not added twice: Inboxora reports it and
offers the migration to the native transport.

## Known limitations

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

Measured on the frozen `dev` SHA **`af97ee5a1ddb6bd1ff0470ee6c8eebb1d577e334`**, with each gate's own exit
status read rather than inferred from a pipeline:

- Backend: typecheck clean, lint clean, **2959 unit tests passed, 209 skipped** (245 files passed, 25
  skipped).
- Frontend: typecheck clean, lint clean, **2782 tests passed, 0 failed**, production build clean.
- Database: a database created empty for the purpose, the **whole 116-migration chain applied from zero**
  by the application's own runner, then **409 integration tests across 45 suites** on PostgreSQL 16 —
  exit 0. (Running the unit suite *and* the integration suites against one database in a single process is
  not a supported combination: independent integration files then contend on the same conversation tables
  and a `SERIALIZABLE` rebuild can hit a serialization failure. The two figures above are the separate,
  supported invocations.)

**Images published from that exact SHA** (documentation-only commits follow it, so the published images are
the current `dev` code). Workflow run
[`35515549348`](https://github.com/Dragonk/Inboxora/actions/runs/35515549348) built and pushed the `:dev` tags
from `af97ee5a1ddb`; both resolve to OCI image indexes carrying `linux/amd64` **and** `linux/arm64`:

- `ghcr.io/dragonk/inboxora-backend:dev` — `sha256:415c0c7e10778c574f91c21a4b43711795faf883bfd904086948d6c5d777a6ff`
- `ghcr.io/dragonk/inboxora-frontend:dev` — `sha256:eb9668376c5557fe724aab6ba917c5cc969f8a017b1f5a1ac8f339f8ee1f5cdf`

**Runtime smoke of that published pair — RUN, and passed.** The pair was pulled and started as a stack
(PostgreSQL, Redis, ntfy, backend, frontend) from a fresh volume: the backend applied the migration chain
and became healthy, `/api/health` answered `{"status":"ok"}`, **`/api/version` answered
`{"version":"dev","sha":"af97ee5a1ddb6bd1ff0470ee6c8eebb1d577e334"}`** — the published image is the frozen
revision — `schema_migrations` held all **117** rows, the first user was registered (admin), a fresh cookie
jar logged in through `POST /api/auth/login`, `/api/auth/me` returned that user, `/api/accounts` returned
`[]`, and the UI root served the application. `docker inspect` reported **0 restarts** for every container
and no migration failed.

**Not run for this revision, and therefore NOT RUN rather than passing:** the manual acceptance list above,
the browser suite and screenshots for this revision, and the CI jobs on a GitHub runner. The live-provider
paths are exercised against faked providers at the HTTP boundary and a real PostgreSQL; no real Google or
Microsoft application is registered in this environment.

## Detailed changes

The area-by-area list — every feature, change, fix and security note — is in
[`docs/CHANGELOG.md`](../CHANGELOG.md) under `[4.1.0]`. The per-package delivery status, the frozen code SHA
and the manual acceptance that remains are recorded in
[`docs/IMPLEMENTATION-STATUS.md`](../IMPLEMENTATION-STATUS.md).
