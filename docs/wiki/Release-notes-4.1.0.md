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

- **Crash-safe deferred native inbox rules.** A Gmail or Microsoft message whose ingest projection lacks a body or
  headers needed by an inbox rule is recorded in the additive `0121_provider_rule_deferred_queue.sql` queue before
  any block-list or rule action runs. The worker reads only missing data, with a lease and backoff for transient
  failures. `0124_message_header_completeness.sql` distinguishes metadata-only headers from a complete header read;
  a confirmed empty body is evaluated as empty, while unavailable content remains unknown. `0125_provider_rule_deferred_dispatch.sql`
  retains the record through the hand-off to an action journal and parks a lease lost after that boundary as
  `outcome_unknown`, rather than replaying an uncertain provider effect. Apply `0121`, `0124`, and `0125` in order
  before rolling out the worker.

- **Safe recovery of a legacy local message after Graph cutover.** `0126_graph_legacy_message_bindings.sql` records a confirmed alias from an old IMAP-era local message to its canonical Graph copy. Inboxora does not manufacture a Graph ID from an IMAP UID or RFC `Message-ID`: ambiguous matches stay visible for review, and cache is not deleted as a substitute for binding.
- **Account-scoped provider services and source controls.** Calendars and contacts can be enabled independently for each Google or Microsoft mail account. `0128_account_provider_feature_settings.sql` preserves already-active linked services during upgrade, but does not turn on a new service merely because an OAuth grant is broad. Disabled services are not scheduled or manually synchronized; an enabled service without a first collection remains eligible for discovery.
- **Calendar sources are grouped and presented independently from synchronization.** Local/system, subscription/DAV, Google and Microsoft sources use stable source/account identities. `0129_calendar_presentation_preferences.sql` persists per-user source collapse and calendar sidebar hiding; these presentation actions do not remove a calendar remotely or change its synchronization/write permissions. Google and Microsoft account sources share account-scoped “sync now” handling.
- **Provider error and status wording is more precise.** Google API-disabled, scope, access, quota and unknown-forbidden responses remain distinguishable. Account cards render one account snapshot for enabled intent, authorization, sync freshness/error and push/polling rather than merging separate status fetches. A Google Contacts API-disabled result directs the owner to the People API configuration step and offers only a controlled status recheck, not repeated OAuth reconnects.
- **Feature enablement now reports preparation rather than a false sync success.** An enabled service answers whether it is queued, requires grant verification, or requires authorization. Manual account Contacts sync is supported alongside calendars and uses the same completion reducer as OAuth finalization; a bounded/incomplete run stays incomplete and retryable.
- **OAuth capability checks now use scopes proven for the current token generation.** `0127_oauth_grant_current_scopes.sql` keeps `current_scopes` separate from historical consent. Existing grants deliberately remain unverified until a flow/token response confirms current scopes; a historic union is not treated as access for a new token.
- **A legacy Graph cache has a bounded repair path.** Confirmed local legacy/native pairs are bound without deleting either cache row; ambiguous candidates become `needs_review` and a later ingest cannot replace an established binding. `0133_graph_legacy_message_binding_repair_state.sql` persists a per-account/per-connection checkpoint and result counts; it runs as a local bounded slice after normal Graph mail sync, without calling Graph or changing its delta cursor. Apply `0133` after `0126` before deploying this worker. Graph body delivery also preserves body content if attachment metadata is unavailable.
- **Gmail reader MIME completeness is explicit.** `0130_gmail_message_completeness.sql` separates rule-body, reader-body and attachment-metadata completeness, so a rule hydration text cache does not falsely prove that reader HTML/files were loaded. The MIME reader supports embedded attachment bytes, attachment-backed text bodies and explicit attachment disposition.
- **Newsletter unsubscribe is recorded as an outcome, not inferred from a link.** Gmail ingest persists unsubscribe evidence, and `0131_message_unsubscribe_attempts.sql` stores pending, confirmed or uncertain one-click attempts. A manual URL or `mailto:` draft is not a completed unsubscribe, and an uncertain POST is not replayed automatically.
- **Native bulk mail actions preserve the native projection.** Mixed transport trash batches keep Gmail/Graph local UUIDs and related metadata, and Gmail API archive stays on Gmail even when an IMAP-era archive mapping exists.
- **Graph default contacts use a real default target.** The local `default_contacts` marker no longer reaches a `/contactFolders/{id}` URL; default results are retained independently from optional contact-folder discovery failures.
- **Contact identity and sender learning are separate.** `0134_contact_local_email_keys.sql` removes the address-book-wide unique e-mail index: two provider contacts with the same address remain separate records, while Inboxora-owned recipient learning remains idempotent through a dedicated local e-mail key. Apply the migration before code that learns recipients or synchronizes contacts.
- **Faster, stable message rows.** Photo decoration now asks whether a matching photographed contact exists instead of joining all matches, so duplicate contacts cannot duplicate or displace messages on a page. Threaded listings also avoid an unused physical-message count.
- **Google consent honours live administrator policy.** A browser callback rechecks the provider/API switch before exchanging its code, so a provider disabled while consent is open cannot create a new grant.
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

- **Apply migrations `0101`–`0131` in numeric order, before rolling out the application.** They are additive and no
  existing table, column or row is rewritten. Several deserve naming: `0110` adds the columns the Microsoft
  device authorization uses and must be applied before a device flow is started; `0111` adds the nullable
  `messages.provider_labels` the Gmail adapter writes; `0112` adds the `read_write` value the per-collection
  write-back switch needs and changes no row, so nothing becomes writable because of it; `0116` creates the
  `message_labels` membership table (MAIL-02), which is written by the Gmail synchronisation and **read by
  nothing yet** — an application version that does not know it leaves it empty, and one that knows it writes only
  there. A mailbox that was synchronised before `0116` therefore has no membership recorded; the new membership
  report compares each message's own label set against its rows and names such accounts, so the gap is measurable
  before anything depends on the table. The flat message list now follows those memberships too: a message carrying
  multiple Gmail labels can appear in each projected label, and an action from that view carries the viewed
  membership as its folder context. Threaded expansion, counts and the remaining archive semantics are not yet
  migrated. `0117` lets a user hold several CalDAV or CardDAV sources: it drops the
  single-row constraint and replaces it with two partial unique indexes, so the unlabelled row per provider remains
  unique while labelled ones coexist. No row is rewritten, and nothing reads the new column yet, so behaviour is
  unchanged until the source model is used. `0118_carddav_source_identity.sql` attaches CardDAV links to their exact source, `0119_gmail_archive_state.sql` records Gmail's archive state without deleting the message, and `0120_provider_rule_headers.sql` stores native-provider headers used by rules. `0121_provider_rule_deferred_queue.sql` creates the leased read-only queue for missing provider rule inputs. `0122_carddav_source_ownership_and_leases.sql` gives each external CardDAV projection a source owner and a fenced lease (ambiguous legacy ownership remains unowned rather than guessed); `0123_gmail_baseline_generations.sql` persists a bounded Gmail baseline's seen set and its final All Mail reconciliation; `0124_message_header_completeness.sql` records whether provider headers are complete; and `0125_provider_rule_deferred_dispatch.sql` records the action hand-off state. Apply all five in that order before deploying their workers. `0126_graph_legacy_message_bindings.sql` adds explicit legacy-to-Graph aliases; `0127_oauth_grant_current_scopes.sql` adds a nullable, intentionally unbackfilled proof of current-token scopes; `0128_account_provider_feature_settings.sql` adds the account/feature intent table and backfills only accounts with an enabled linked projection; `0129_calendar_presentation_preferences.sql` adds per-user source-collapse and sidebar-hidden preferences; `0130_gmail_message_completeness.sql` adds independent Gmail rule/reader/attachment completeness flags; and `0131_message_unsubscribe_attempts.sql` records durable unsubscribe-attempt outcomes. Apply `0126`–`0131` in numeric order before serving their code. `0134_contact_local_email_keys.sql` must run after the existing contact/address-book migrations and before application code that learns recipients or synchronizes contacts: it creates the Inboxora-local learning key, backfills only address books whose source is `local`, then replaces the address-book e-mail uniqueness constraint with a lookup index. The earlier migrations are additive; `0134` changes only the named index and does not merge or delete contacts. All must be applied before this application version runs.
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

- **Preparing Microsoft message identities (optional, not automatic).** Existing Graph rows use the default
  message id, which can change when a message moves. Before enabling immutable ids, run the translation in plan mode,
  review the mapping and unavailable/colliding rows, then apply it only when the plan is complete. The application
  records the successful translation on the connection and only then adds `Prefer: IdType="ImmutableId"` to Graph
  mail requests. This release does not expose an automatic command or enable the preference by default; a real
  mailbox must validate the translation before the switch is used.

- **Microsoft message identifiers can be migrated to their permanent form.** Inboxora can ask Microsoft for each
  stored message's permanent (immutable) identifier and record it, which is the step that has to happen before any
  synchronisation may rely on those identifiers — relying on them first would duplicate every message in the
  mailbox. The migration can be planned without writing anything and then applied, in batches. Nothing uses the
  permanent identifiers by default, and the migration should be validated against a real mailbox before it is made
  the default.


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
- **Push hints respect disabled optional services, but are not proof of subscription cleanup.** The scheduler gates
  calendar/contact push hints with the account feature setting (`b028ebd0`); a disabled service does not call its
  adapter from that hint. Existing upstream subscriptions, their expiry/cleanup and a live provider delivery path
  still require environment validation.
- **Account service intent now gates account-owned native writes where ownership is explicit.** Google and Microsoft
  calendar writes plus Google People contact writes resolve `integration_collections.account_id` and refuse a missing
  or disabled feature setting before reaching the provider. It is still **not** a universal DAV/source ownership gate:
  externally owned CalDAV/CardDAV, local and ICS targets retain their source-specific policy, and already-running work
  cannot be retroactively undone. Validate DAV/source ownership behavior separately before treating a feature toggle
  as a universal authorization boundary.
- **Google personal contacts only**, no shared directory, and no remote creation or sharing of collections;
- a **legacy external CalDAV/CardDAV collection** gains its write-back link on the next sync of its source
  rather than through a one-shot migration;
- **invitations are Inboxora's on a CalDAV collection**: a plain CalDAV server is not a scheduling service, so
  an event with attendees created in such a collection is mailed by Inboxora rather than by the source.

## Manual acceptance not run

These need a real provider, device or client. They are **NOT RUN**, not failures:

- **live Microsoft** — authorization (browser and device code), Graph mail, calendars, contacts, send and
  provider-side search against a real mailbox, including a legacy-message binding after a real cutover and contact
  discovery where the default folder has a non-empty `parentFolderId`;
- **live Google** — OAuth, the Gmail API, Calendar and People, including API-disabled/access/scope 403 diagnosis,
  first calendar discovery after enabling the service, and push-hint behavior;
- **a real mailbox cutover** from IMAP/SMTP to Graph or the Gmail API;
- **DAV clients** — DAVx⁵, Thunderbird and macOS Contacts/Calendar, including write-back;
- **the browser suite and documentation screenshots** for this revision on a runner, and the **CI jobs on a
  GitHub runner** (every command was run by hand against a real PostgreSQL);
- **a real touch device** for the drawer gesture.

## Verification

The following measurements are from the earlier frozen `dev` SHA **`561262b4cb3b554fb8e9a2821224d49ee7206f36`**; they do **not** validate the later second-audit commits documented above. Their provider and UI paths still require the focused/local gates and the live acceptance listed here, with no claim of live validation:

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

### Changed

- **Microsoft calendars: the preview/stable choice for change tracking is explicit and off by default.** Microsoft
  documents the per-calendar event delta as a preview capability; the stable alternative returns repeating events
  in a shape that loses the series. Inboxora keeps using the stable contract unless an operator sets
  `GRAPH_CALENDAR_DELTA_VERSION=beta`, which then reads each changed event in full (one extra request each). Writes
  stay on the stable contract in both cases. Neither path has been exercised against a real mailbox here.

- **Internal: a two-step calendar change now records its progress.** Splitting a repeating event writes twice; if
  Inboxora stops between the writes, the operation's own record now says which part completed and holds the
  information the second part needs, instead of leaving an unexplained unknown outcome. A change that was
  interrupted is now finished from that record rather than abandoned — the first write is not repeated, and the
  second uses the snapshot the operation recorded. When the outcome of the second write was never recorded,
  Inboxora now looks for the second series before deciding: if exactly one event matching what it was about to
  create is already there, that is the result and nothing is created again; if none is, it creates it; if more than
  one matches, it reports that a person has to look rather than risk a duplicate. An interrupted split therefore
  completes exactly or is reported, never silently duplicated. The lookup has been tested against what the
  providers are documented to return, not against a live mailbox.

- **Internal: the transport seam now has a Gmail and Microsoft implementation.** The actions the inbox rules
  perform — move, delete, read/starred — can now be carried out on a native account through the same services
  the app already uses for those writes. Nothing calls it from a native synchronisation yet, so behaviour is
  unchanged in this release; it is the remaining step before rules and the block list can run there.

- **Internal: the provider flag write is now a service, not route-private code.** Setting read/starred on a Gmail
  or Microsoft message was implemented inside the mail route because it needed the IMAP manager imported from the
  application root. It now takes that side as a parameter and lives beside the provider adapters, so the inbox
  rules can use it. No behaviour changed.

- **Internal: the inbox rules and the block list now act through a transport seam.** They were written against
  the IMAP manager, which is why they only run for IMAP accounts; extracting the actions they perform is the
  prerequisite for running them on Gmail and Microsoft accounts. No behaviour changed for IMAP, and nothing
  changed for native accounts yet — this release ships the seam, not the provider side.

### Fixed

- **CardDAV sources are isolated during synchronization and write-back.** Each source now has its own durable integration identity, credentials, pruning scope, timer and disconnect operation; the Contacts panel selects the source for sync and disconnect. Apply migration `0118_carddav_source_identity.sql` before rolling out the application change; ambiguous legacy links fail closed and live DAV validation remains required.

- **Gmail baseline resumes within a page instead of restarting it.** A durable set of processed thread IDs lets a bounded run advance through pages larger than its per-run budget.

- **Native inbox rules receive normalized provider metadata and fail closed on unknown content.** Missing lazy bodies, headers or sender metadata no longer satisfy negative conditions that could move or delete mail; retry/live-provider hydration remains required for fields not stored locally.

- **Gmail archive preserves the local message object.** Removing INBOX records an explicit archived state and updates label membership instead of deleting the message, preserving IDs, annotations and thread history. Apply migration `0119_gmail_archive_state.sql` before rollout.

- **Microsoft Graph calendar delta uses only the documented beta item-delta contract.** Reduced events are read back in full; `GRAPH_CALENDAR_DELTA_VERSION=v1.0` is rejected before it can send an unsupported request. Live-tenant validation remains required.

- **Graph calendar expansion preserves read failures.** A 401/403, 429, timeout or 5xx is no longer converted to a deletion tombstone, so the cursor cannot advance as if the event had been removed. A live Microsoft tenant test is still required.

- **Graph preferences are combined and Google recurrence clearing remains explicit.** Paging/time-zone preferences are sent together with immutable-id mode, and an explicit `recurrence: null` no longer recreates the prior recurring series.

- **Calendar occurrence retries consult the mutation journal before live occurrence lookup.** A retry after a master split can use the stored occurrence identity instead of incorrectly returning `OCCURRENCE_NOT_FOUND`.

- **Calendar split recovery no longer creates on an empty bounded search.** An accepted create with a lost response remains `outcome_unknown`; Graph remainder creates also carry a stable journal operation transaction ID.

- **Inboxora now asks a CalDAV or CardDAV collection what may be written to it.** It used to assume every
  collection accepted writes, so an edit failed at the server each time. The collection's own permission list is
  read when it is synchronised: a collection that grants only reading is shown and treated as read-only, and one
  that will not answer keeps the previous behaviour, with a refused write still recorded as a refusal. The
  interpretation has been tested against the documents servers are documented to send, but not yet against a live
  DAV server.

- **Correction to an earlier note in this release:** a report that a blocked message disappeared during a Gmail
  account's first full synchronisation was traced to the test's own fake, which kept listing the message under
  INBOX after the move — so the synchronisation correctly treated the row it had just re-filed as one the provider
  no longer holds. With a fake that reflects the move, the blocked message is moved to trash, survives the
  synchronisation and is filed there. Related and already fixed: a provider message's internal identifier was being
  rounded, which made an ingest action fail without saying so.

- **Blocked senders work on Gmail and Microsoft accounts; your rules do too, once an operator turns them on.**
  Rules can be global and can delete mail, so they are not switched on for provider accounts automatically — an
  upgrade would otherwise start applying rules a mailbox never ran, including deletions. Set
  `PROVIDER_NATIVE_RULES=1` to enable them; until then the synchronisation reports that it skipped them.
- **Your rules and blocked senders now work on Gmail and Microsoft accounts too.** They previously applied only to
  IMAP accounts: a blocked address kept arriving and no rule ran. Blocking an address now moves its new mail to
  that account's trash (or deletes it, when the account has no trash folder), and rules can move, archive, label,
  mark read or star, delete, and forward — carried out on the provider. These paths are covered by tests but have
  not yet been run against a live mailbox, so the first real-account synchronisation is worth watching.

- **Contacts in every Microsoft contact folder are imported.** Previously only the default folder was read, so
  anything kept in another folder (or in a folder inside one) stayed invisible. Each of those folders now becomes
  its own address book, which you can enable, disable and publish to devices separately, and a problem with one
  folder no longer stops the others.

- **Changes to a CardDAV contact are sent back with the version Inboxora read.** Each imported card now records
  where it lives on the server and the version it had at that moment, so an edit is sent as a change to that
  resource rather than being looked up by scanning the address book, and the server can reject the write if
  someone else changed it first. Cards that disappear from the source have their records retired with them.

- **Microsoft contacts now synchronise from the folder they actually live in.** Inboxora asked Microsoft for a
  contact folder named "contacts", which is not an identifier the service accepts, so the mailbox's contacts
  could not be read. The folder is looked up first and its real identifier used, both for reading and for writing
  changes back. Already-connected mailboxes keep their address book, their synchronisation position and your
  write-back setting. Contacts that live in extra folders beyond the default one are not pulled yet.

- **Changing "this and following" on a repeating event no longer changes how many times it repeats — including
  when the editor sends the rule.** The count that came with the edit belonged to the whole series, so the second
  half used to start the count again. It now continues with only the occurrences that are left, and if that
  cannot be worked out the change is refused instead of producing a series that disagrees with itself.

- **An account whose first synchronisation failed now recovers on its own.** Inboxora only scheduled connections
  that already had collections, so a connection whose first run failed — or one interrupted by a restart — was
  never retried: the mailbox appeared connected and stayed empty. Connections that hold nothing are now picked up
  and their discovery is retried, using the same discovery their first run used. A collection you disabled, or one
  with no local link, is still left alone, and connecting calendars or address books remains an action you take.

- **The Microsoft calendar change-tracking request now asks only for what Microsoft's contract allows.** It
  previously combined the delta call with projection and paging parameters that delta does not support, so the
  request could not be answered as written. The remaining question — the per-calendar delta form this
  synchronisation relies on is documented as a preview capability while the stable version returns repeating
  events in a shape that loses the series — needs validation against a real Microsoft mailbox before it is
  changed, so it is deliberately not switched yet.

- **A CardDAV synchronisation no longer changes your Google or Microsoft contacts.** With duplicate merging on,
  a matching email caused the imported card to be written over the provider-synced contact — a change Inboxora
  could not send back to that provider, so the next synchronisation undid it and the edit was lost. Merging now
  applies only to your own local books and to other books of the same CardDAV source; when the duplicate belongs
  to Google or Microsoft, both contacts are kept.

- **Connecting a CardDAV source shows its address books immediately.** The books it pulls used to appear only
  after a manual page reload, so a freshly connected source looked like it had imported nothing.

- **A failed CardDAV synchronisation no longer leaves contacts missing.** The pull deletes the rows the server
  no longer lists, then writes what it found; those steps are now one transaction, so an interrupted run leaves
  the address book exactly as it was instead of missing entries until the next successful synchronisation.

- **A CardDAV address book shows its real last sync and can be synchronised from its own panel.** The books
  manager only knew Google and Microsoft, so a CardDAV book always read "never synchronised" and had no sync
  button. It now reports the DAV source's last sync (or failure) and offers the action, next to the book it
  applies to.

- **Replies sent from a Microsoft mailbox now thread correctly.** They used to be sent as new messages with
  reply headers that Graph does not accept, so Outlook and Inboxora saw no relationship to the message being
  answered. Inboxora now asks Microsoft to create the reply (or reply-all/forward) itself and fills in the
  content, which is what gives the message its conversation. A reply to a message stored in another mailbox is
  sent as a separate message, deliberately, rather than pretending to be a reply to something it is not.

- **An address book you switched off is no longer synchronised by hand either.** It was already excluded from
  the automatic schedule, but a manual "sync contacts" still pulled it. Both providers now skip a disabled book
  and leave it and its contents alone.

- **A repeating-event change now refuses before it changes anything.** Changing "this and following" is two
  provider writes; the original was shortened before the request was validated, so a request that could never
  succeed could still end the earlier part of the series. Validation and payload building now happen first. The
  two writes are not yet resumable across a crash, which remains a known limitation.

- **The card no longer says instant sync is on when the mailbox only polls.** The push state collapsed a
  subscription that exists but is failing, renewing or removed into "missing", and the schedule was labelled
  push-and-polling for every provider-API mailbox. The state now distinguishes those cases and shows when a
  renewal is due, and the schedule label says "scheduled and push" only when a subscription is really active.

- **Calendar links carry the provider's version, not a local fingerprint.** The stored "remote version" of a
  synced event was a hash of the local copy, which changes for local reasons; a CalDAV write-back could then
  send a precondition the provider never issued. It is now the provider's own version (Google `etag`, Microsoft
  `changeKey`), and empty when the provider gives none.

- **Editing a moved occurrence of a repeating event works again.** Inboxora looked for it in a one-day window
  around the original date, so an instance moved further than that was reported as missing; it now widens the
  search only when the first attempt finds nothing. The comparison also no longer confuses two timed occurrences
  on the same day, and Microsoft timestamps without a time zone are read as UTC rather than in the server's zone.

- **Changing "this and following" on a repeating event no longer changes how many times it repeats.** Splitting
  a series now continues with the remaining occurrences instead of restarting the original count, the end value
  of an all-day series is a date (as the calendar standard requires) rather than a date-time naming another day,
  and a Microsoft series ends on the correct day in its own time zone instead of the previous day in UTC. A
  split that cannot be represented is refused before anything is changed.

- **A folder you deleted at Microsoft no longer blocks the mailbox.** Discovery kept treating a vanished folder
  as a target, kept asking for it, and the 404 it got ended the synchronisation of every other folder in that
  mailbox. A complete folder listing now retires the folders it no longer contains, and a folder that cannot be
  synchronised no longer stops the rest — only a lost lease or an unusable connection does.

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
