# Release notes 4.1.0

**Status:** prepared on `dev`, **not released** — a version is released when `dev` is merged to `main`
· **Previous version:** 4.0.4 · **Type:** minor

## What this release is

4.1.0 adds the **native provider integration layer**: connecting Google and Microsoft accounts so
Inboxora can pull their **contacts and calendars** directly, instead of relying on a feed URL or a
CSV export. It also builds the **native Microsoft Graph mail adapter** — the code that reads, files
and flags Microsoft mail through Graph instead of IMAP — hardens the DAV server, and fixes several
defects found while doing so.

The policy it implements is deliberately asymmetric, because the two providers are not in the same
position:

- **Google is optional.** Mail keeps working over IMAP/SMTP with an **app password**, exactly as
  before. Registering a Google OAuth client adds the contacts and calendars pull; it does **not**
  migrate mail, does not ask for Gmail permissions, and not configuring it leaves the app-password
  path fully available.
- **Microsoft needs the connection for mail.** Outlook.com and Microsoft 365 no longer accept a
  mailbox password, so those accounts need an authorized connection. Microsoft mail travels over
  OAuth2 IMAP/SMTP, and the **native Graph transport is now implemented and wired** (read, file,
  flag and **send** through the single send seam); no account is migrated to it in this release, so
  an existing account keeps using IMAP/SMTP until the in-place cutover (see limitations).

Everything the providers deliver is **pulled read-only**. Editing, deleting or removing an imported
collection through Inboxora is refused with a reason rather than silently undone at the next refresh:
the provider is the writer of its own data, and Inboxora does not pretend otherwise.

## Connecting accounts

An administrator configures the provider once, under **Settings → Integrations → Email providers**,
and each user then authorizes their own account. The two roles stay separate, and configuring an
application creates no account.

- **Google**: Client ID, Client Secret and the exact redirect URI, with a step-by-step procedure and
  the card reporting readiness per method. **There is no Google device-code option** and none is
  offered: Google's limited-input device flow does not carry the Gmail, Calendar or People scopes.
- **Microsoft**: Client ID and tenant, with **two independent methods** — the browser flow (which
  needs a secret and the callback) and the **device code** (which needs neither, only *Allow public
  client flows* in Entra). Either can be configured without the other, and switching one off is
  enforced rather than cosmetic. Both methods exist for the **mailbox** sign-in and for the **Graph
  connector**: the connector no longer requires a callback or a secret to be authorized, so a
  public-client registration is enough to pull contacts and calendars.
- **Per-method readiness** distinguishes "configured" from "working conditions present", the card
  states each provider's policy in place, and a provider, a method or the whole layer can be turned
  off — including installation-wide with `PROVIDER_INTEGRATIONS_ENABLED=0`, which also stops the
  sync paths.

Disconnecting an account revokes its grant and deletes its stored tokens; the imported data stays,
and reconnecting re-links the same collections rather than duplicating them.

## Added
- **Google Calendar and Google Contacts write through the provider journal.** An event or a contact
  created, edited or deleted in Inboxora and belonging to a write-enabled Google collection is now
  written to Google first — `events.insert`/`patch`/`delete` and
  `people.createContact`/`updateContact`/`deleteContact` — through the same journal and the same
  provider-first order the Microsoft paths use. A refusal leaves the local copy untouched, an ambiguous
  answer is parked and never retried, a created resource keeps Google's own identity (`event.id`,
  `people/c…` resource name) and is linked so the next sync updates it instead of duplicating it, and the
  journal records the **local** resource id, not the provider's. Google sends the attendee notifications
  itself (`sendUpdates`), so Inboxora does not send a second invitation on a provider calendar. Writing a
  pulled collection back remains an explicit per-collection opt-in, and a calendar Google reports as
  read-only stays refused.
- **The Google mail migration recommendation, with a durable "do not show again".**
  `GET /api/integrations/notices` lists the recommendation for the caller's own Google mailboxes still on
  IMAP/SMTP — and only while the provider layer, the Google method and an OAuth client are all in place,
  because recommending a destination that does not exist is a dead end.
  `POST /api/integrations/notices/:accountId/suppress` records a per-user, per-account suppression in
  `account_notice_preferences` (no schema change). *Ignore* remains a dismissal the interface forgets; the
  suppression is the one that survives a reload and a second device. The **accounts settings show the
  recommendation for each affected mailbox**, with *Ignore* and *do not show again* side by side so the
  difference between them is visible. The **Microsoft requirement notice cannot be suppressed** — the
  table's closed notice-type check has no value for it, which is what keeps a requirement from becoming
  optional.


- Provider contracts and a registry, with additive schema (`0101`–`0106`): connections, grants,
  remote links, sync state, operations, an outbox and notice preferences.
- The Google vertical end to end: OAuth with PKCE, the Calendar and People adapters, discovery,
  scheduled refresh, collection settings, connector status, per-collection enable/disable.
- Microsoft Graph contacts, and the Microsoft device-code flow with a per-flow id, owner checks,
  separate readiness and server-side polling limits.
- The **capability model** that decides collection access in the production request path, and the
  **typed provider-mutation layer** with an operation journal: a claim is committed before the
  provider call, so a recovered non-idempotent operation is parked as `outcome_unknown` rather than
  run a second time.
- **Microsoft Graph calendar-event write-back**, on the same explicit per-collection switch: creating,
  editing or deleting an event in a write-enabled Microsoft calendar writes to Graph first, a refusal
  leaves the local copy untouched, a created event keeps the provider's identity (so the next sync updates
  it rather than duplicating it), and Microsoft's own attendee notification is not duplicated by
  Inboxora's invitation mail. Times are sent as the exact instant; a local recurrence is rendered into
  Graph's own pattern/range from the same validated rule the local `RRULE` comes from.
- **Microsoft Graph contact write-back, behind an explicit per-collection switch.** Creating, editing or
  deleting a contact in a pulled Microsoft address book writes to Graph first and only then to the local
  copy, through the same provider journal that fences every other provider mutation; a contact the
  provider no longer has counts as removed, and a newly created one keeps the provider's identity so the
  next sync updates it instead of duplicating it. A pulled collection is still read-only until the user
  turns write-back on for that specific collection, and the switch refuses when the provider itself does
  not allow writes or when no adapter can forward them yet. Migration **`0112`** adds the `read_write`
  value the switch needs.
- **Microsoft Graph calendars**, on the same connector as contacts: every calendar is discovered and
  pulled with its events into a local calendar that starts read-only and hidden from DAV devices. A
  recurring event stays one resource — Graph's structured recurrence becomes an `RRULE`, the wall time
  keeps its zone with a generated `VTIMEZONE`, and a moved or cancelled instance is a
  `RECURRENCE-ID` override inside its master — and a calendar Microsoft marks as not editable is
  recorded as such rather than offered for writing.
- The Graph connector's **device-code authorization**: the provider connection can be created by a
  public client — no secret and no callback — with the device code, the provider's poll interval and
  the last poll held on the flow row, so a restart does not strand a pending authorization. Requires
  migration **`0110`**.
- The **native Microsoft Graph mail adapter** (`backend/src/services/providers/microsoft/`): mail
  folder discovery and management (create, rename, delete, empty, ensure), message metadata sync
  with a per-folder delta cursor and a `410` rebuild, body and attachments (single, inline and ZIP),
  read/unread and star, mark-all-read, source headers, move, archive, single and bulk delete,
  spam/ham, snooze in both directions, conversation grouping on Graph's `conversationId`, and GTD
  label folders and copy removal. Every write goes through the shared mutation layer.
- Additive schema for the above (`0107`–`0109`): the mail-folder collection link, the message's
  provider identity with a partial unique index, and the operation payload that makes the pending
  pool drainable.
- The **send pipeline onto the canonical model, and its Graph transport**: one composition of the
  message, an explicit delivery envelope, a transport seam that binds an account to SMTP or Graph,
  and a Graph send that is **draft-first** — Graph JSON (so `bccRecipients` carries blind recipients
  out of band), attachments added inline or through a resumable upload session, then the send — with
  `accepted` / refused-before-acceptance / unknown-outcome told apart so an uncertain send is parked
  rather than retried.
- A `dev`-tagged image publication from the integrating branch. **The `dev` images are development
  builds, not this release**: 4.1.0 is released when `dev` is merged to `main`.
- The **Gmail API mail adapter's read path** (`backend/src/services/providers/google/gmail*.ts`):
  Gmail labels discovered as mail folders — the system mailboxes keep the canonical local paths and
  `special_use` values, user labels keep Gmail's own names (and its own `/` hierarchy), and the labels
  that are message attributes rather than mailboxes are deliberately not turned into folders — each
  linked by its immutable label id through `integration_collections` (`kind = 'mail_label'`, a value
  `0101` already declares). Messages are ingested through a **mailbox-wide history cursor**
  (`users.history.list` from a stored `historyId`); a first run builds a **resumable** baseline that
  records the mailbox's `historyId` before it lists anything, so a change arriving mid-run is replayed
  afterwards instead of being skipped, and an expired history id (Gmail's `404`) or a delta larger than
  one run's budget rebuilds from a baseline **and reconciles**. A Gmail message is in several places at
  once; the row holds the **primary** folder its label set gives it and the complete label id set in
  the new `messages.provider_labels`, and its thread id goes in the thread identity column in the same
  `gmail:` form IMAP's `X-GM-THRID` uses, so conversations group through the existing engine. Label
  create/rename/delete run through the shared **provider-mutation layer** with the same durability
  rules as every other provider write. Requires migration **`0111`**.
  **This does not change any existing Google account.** Nothing in this work sets
  `mail_transport = 'gmail_api'`: the app-password IMAP/SMTP path stays the transport for every Google
  account until an explicit in-place cutover (P12) implements the move, and the Gmail API code is
  unreachable for an account that has not been cut over to it. **Body and attachments are read on
  demand**: one `format=full` read answers the MIME tree, the body and the attachment list together;
  the HTML is sanitised and cached in the same columns the IMAP path writes; inline `cid:` images are
  embedded as data URIs under a bounded count and byte budget; a download addresses Gmail's own
  attachment id under the same per-file ceiling the IMAP and Graph paths enforce; and the body,
  source-header, attachment, attachment-ZIP and forwarded-attachment paths all dispatch on the
  account's transport, so a Gmail message is never read over IMAP. **Message mutations** go through
  the shared provider-mutation layer, where Gmail's own semantics decide each operation: a flag is a
  label (`\Seen` is the absence of `UNREAD`, `\Flagged` is `STARRED`), a move adds the destination
  label and removes the mailbox the message leaves (which is also what trash and spam/ham are),
  archiving is **removing `INBOX`** — Gmail has no Archive label, so the row moves to whichever label
  remains or leaves the local view — a permanent delete is `messages.delete`, and mark-all-read is one
  journal-backed flag write per unread message. All of those are state sets on labels and are declared
  idempotent, unlike the delete. **Send** is a branch of the existing send seam — not a second pipeline
  in the route — and maps Gmail's answer onto `accepted` / refused-before-acceptance / unknown-outcome,
  so an uncertain send is parked rather than retried; the size ceiling is Gmail's own raw-message limit,
  checked before dispatch. One provider fact changes the **Bcc** rule and is worth stating plainly: the
  Gmail API's `Message` resource has **no envelope field** (verified against the API discovery document),
  and Gmail's own documentation says the send delivers "to the recipients in the `To`, `Cc`, and `Bcc`
  headers". The Gmail arm therefore **keeps** the `Bcc:` header — removing it would silently drop every
  blind recipient — and relies on Gmail, like any submission agent, to keep that header off the copies it
  delivers. The SMTP arm still removes it and relies on the envelope. **Saved drafts** are Gmail's own
  `Draft` object: saving creates it, re-saving patches the same object, deleting removes it at Gmail
  first, and the local mirror is keyed on the **message** id the draft wraps (the identity the sync
  reconciles on) with the draft id resolved from the provider when it is needed. The Gmail API adapter is
  therefore **complete** — what remains is the account cutover, which is what makes it reachable, and live
  acceptance, which is NOT RUN.

## Fixed
- **Inbox-rule forwards from a native Microsoft Graph account.** A rule that forwards mail could not work
  for an account on `mail_transport = 'microsoft_graph'`: the forwarder read the source message over IMAP
  (a connection the mailbox does not have) and delivered through the SMTP factory, which refuses a native
  Graph account by design. Reading and sending now follow the account's own transport — the body through
  the same Graph reader the message-body route uses, files through the shared attachment dispatcher under
  the per-file ceiling, and delivery through the send seam. IMAP/SMTP accounts forward exactly as before.
  **Delivery state:** `sent` is recorded only when the provider accepts; a refusal read before acceptance
  releases the reservation so a deliberate retry can send; an interrupted or unknown provider response
  leaves it **pending**, so a later rule run reconciles rather than sending a second copy, and the forward
  is never reported as sent. A source account with no body reader yet (native Gmail) is refused with a
  named error instead of being read over IMAP, and a legacy Microsoft row with no provider identity still
  forwards from its cached body but refuses a forward that would need an uncached Graph read. No migration.

- **A Google collection could never actually be opted in for write-back.** The Calendar and People syncs
  recorded `source_access = 'read_only'` unconditionally, so the per-collection write-back switch refused
  every Google collection with `SOURCE_READ_ONLY` and the new Google write paths were unreachable outside
  tests. The calendar sync now records Google's own answer (`accessRole` `owner`/`writer` means writable)
  and the contacts sync records the People API's answer for the user's own contacts, refreshing that fact
  on each discovery **without** touching `enabled` or `user_access`. A share upgraded from reader to writer
  is therefore picked up, and a shared read-only calendar still cannot be made writable.
- **A provider collection was advertised as DAV-writable when the DAV handlers cannot write it.** The DAV
  ceiling came from the adapter's write-through flag, but the CalDAV/CardDAV handlers forward only for the
  external CalDAV/CardDAV client (and accept a write for the local store). A Microsoft Graph or Google
  collection would have been accepted over DAV and applied to the local copy, which the next provider sync
  discards. The DAV mode now requires the DAV channel to be able to forward, so such a collection is DAV
  read-only while staying writable over the web channel — and a DAV client can no longer be told it may
  write something the server would silently drop.


- **Bulk read/unread on a native account opened an IMAP connection.** The bulk route grouped the
  selected messages by account and then called the IMAP flag write for every group, so a Microsoft
  Graph or Gmail API account — which has no IMAP session — had one opened for it, and the response
  reported the change as applied whether or not the provider received it. The write now dispatches on
  the account's transport through the shared journal on every path, both native transports included;
  a route test pins that an IMAP account still uses the IMAP write and a native one never does.
- **Device-code polling** could make the server call Microsoft once per poll; a poll arriving before
  the provider's interval is now answered from the flow's own state.
- The **refresh schedule ignored `Retry-After`**; a throttled provider now doubles the wait towards a
  ceiling, with jitter, and a healthy pass returns to the normal cadence.
- A **CalDAV time-range query** returned every recurring candidate, including series that never
  occur inside the window; the recurrence projection now decides.
- **DAV report dispatch** used a substring search, so a multiget naming a resource whose filename
  contains another report's name was read as that report; the root element decides.
- The **DAV and OIDC response bodies** were unbounded; both are capped and refuse the excess.
- An **ICS import could overwrite an invitation-owned event**; the import now leaves those untouched
  and reports a protected count.
- A **provider refresh could re-enable a collection** the user had disabled.

## Configuration and migration requirements

- Apply migrations **`0101`–`0112` in order, before rolling out the application**. They are
  additive; no existing table, column or row is rewritten. `0110` adds three nullable columns to
  `oauth_authorization_flows` for the device authorization and must be applied before a device flow
  is started, not merely before the application starts. `0111` adds the nullable
  `messages.provider_labels` array the Gmail API adapter writes; it must be applied before that
  adapter runs, and an application version that predates it simply leaves the column `NULL`.
  `0112` extends the `integration_collections` write-access check with the `read_write` value and
  changes no row, so nothing becomes writable because of it.
- New optional variables: `PROVIDER_INTEGRATIONS_ENABLED` (`0` disables the whole provider layer,
  including the sync paths) and `PROVIDER_SYNC_INTERVAL_MINUTES` (refresh cadence; `0` leaves
  syncing to the user). Both are documented in `.env.example` and the wiki.
- No provider credentials are required: with none configured, mail, contacts, calendars and DAV
  behave as in 4.0.4.

## Known safe limitations

- **A provider account is moved only when an operator moves it.** Microsoft Graph and the Gmail API are
  transports, not defaults: `mail_transport` stays `imap_smtp` (or `NULL`) until
  `POST /api/accounts/:id/migrate` cuts one account over, in place and without adding a second account,
  so an existing mailbox keeps reading and sending over IMAP/SMTP until that explicit action. Because
  the cutover is per account and deliberate, the native paths — Graph and Gmail send, drafts, search,
  folders, flags, mutations, attachments and the rule forwarder — are exercised by tests and by any
  account an operator has cut over, rather than by every account automatically.
- **One consequence of modelling Gmail's plural labels on a single `messages` row is decided** rather
  than left to the first cutover: a message in the inbox that also carries user labels appears **once**,
  in the inbox, with its additional labels retained in `messages.provider_labels`.
- **Provider data is read-only by default, and imported collections stay that way until you enable
  write-back for them** — per collection. Microsoft Graph and Google collections can be written **over
  the web interface** once enabled; **over DAV a provider collection stays read-only**, because the DAV
  server forwards a write only to an external CalDAV/CardDAV source, and advertising anything else would
  invite a change the next sync discards. The capability model is the single decision point, the
  interface reads the server's `read_only` rather than re-deriving editability from a calendar's origin,
  and the write-back switch refuses rather than accepting a change it cannot forward (a calendar the
  provider marks read-only, or a source whose write path does not exist yet). A legacy CalDAV/CardDAV
  collection imported before this release has no write-back record yet, so it stays read-only over DAV
  until one is created for it — the import paths create one for new imports.
- **The Google migration recommendation is shown in the accounts settings**, per affected mailbox, with
  *Ignore* (this session) and *do not show again* (durable, server-side). A mailbox the server does not
  report an active notice for is never guessed at by the interface.

### Provider-side search for native Microsoft Graph accounts (P07b)

Inboxora's search box reads Inboxora's own `messages` table. For a Graph-served mailbox that holds only
what the delta cursor pulled, so older mail — or mail in a folder the sync never visited — answered "no
results" for messages that exist. A search scoped to a native Graph account now asks Graph's search index
first and lands the hits in the local model before answering, so results are local rows as before and
threading, opening, flagging and attachments work unchanged.

Two limits are stated rather than hidden: a hit whose folder is not linked to the account (a disabled
collection, or a folder created after the last refresh) has no local path and is **skipped and counted**,
never guessed; and a provider failure returns the local results unchanged with a `providerErrors` entry
naming the account and the reason. Search is a read into the local model, not a sync — it never touches a
delta cursor. No migration is required. Only `microsoft_graph` is in scope (a Google account still
searches locally), and `PROVIDER_INTEGRATIONS_ENABLED=0` stops the outbound search. **NOT RUN**: the
provider is faked at the HTTP boundary and no live Outlook mailbox was searched.

### An existing Microsoft account moves to the native Graph transport in place (P12, Microsoft half)

`POST /api/accounts/:id/migrate` (optional body `{ connectionId }`) moves an existing Microsoft account
to the native Graph transport **without adding a second account**: the `email_accounts.id` is unchanged,
and every local message, folder, draft, alias and conversation is left exactly as it was.

- The switch succeeds only when an active Microsoft connection whose grant carries **`Mail.ReadWrite`
  and `Mail.Send`** resolves for the account — either named explicitly or matched on the verified
  provider identity — and only for an account the caller owns. An explicitly named connection whose
  verified address is **not** the account's is refused (`ACCOUNT_MIGRATION_IDENTITY_MISMATCH`) rather
  than silently switching the account onto another mailbox; the deliberate alias case passes
  `allowIdentityMismatch: true`, so the exception is a stated decision rather than an accident.
- It is **one atomic update** under a row lock (`mail_transport`, `provider_connection_id`, `protocol`,
  `migration_state = 'active_native'`, transport generation + 1), so a crash leaves either the whole
  switch or none of it, and a retry on an already-switched account is a no-op rather than a second
  migration.
- A refusal is recorded in `migration_state`/`migration_error_code` (`authorization_required`,
  `admin_configuration_required`) and **never changes the transport** — mail keeps flowing over
  IMAP/SMTP until the connection is fixed. After the switch there is **no fallback** to Microsoft
  IMAP/SMTP: every route dispatches on `mail_transport`, and the IMAP loops and health checks now filter
  on that authoritative column too, so a native account cannot be reopened over IMAP even if the legacy
  `protocol` field is ever reset.
- The cutover moves the **transport, not the data**: the first Graph sync is a normal adapter ingest, and
  the full inventory/backfill/reconcile state machine is not part of this slice, so an existing IMAP row
  and its Graph counterpart can coexist until a reconcile. No new migration is required — `0101` already
  declares every column used — so the order stays `0101`–`0112`.
- **NOT RUN.** A real Microsoft mailbox has not been cut over; that stays manual acceptance.

### Editing an imported CalDAV or CardDAV collection now reaches its server (P10)

A calendar or address book that Inboxora imported from an external CalDAV or CardDAV server can be
edited from a DAV client: a `PUT` or `DELETE` is forwarded to the server the collection came from
rather than applied only to Inboxora's copy, which is what makes the collection genuinely read/write
for DAVx⁵, Thunderbird and Apple Contacts once write-back is enabled for it.

- The precondition the client sent is honoured at the source as well: a create is sent with
  `If-None-Match: *`, an update or delete with the entity-tag Inboxora last read. If the source's copy
  changed, the write is refused with `412` and the client re-reads instead of overwriting.
- The local copy and the remote link are updated only after the source confirms. A refusal or an
  ambiguous answer (a `5xx`, a timeout, a reset after the request left) leaves the local row untouched
  and answers `502`/`503`; nothing is reported as saved unless it was, and an ambiguous one is never
  retried automatically.
- An ICS subscription has no write channel and stays read-only; an `.ics` file imported into a local
  calendar remains locally editable.
- **Validation.** Unit tests cover the source-status classification and the on-the-wire precondition
  and entity-tag forwarding; a real-PostgreSQL integration suite covers the journal claim, the local
  projection and the remote link against a local fake DAV server.
- **NOT RUN.** Acceptance with real clients (DAVx⁵, Thunderbird, macOS Contacts/Calendar) has not been
  run and remains manual acceptance.
- **The migration prompt with *Ignore* and "do not show again" is not in this release.** What exists
  is the requirement stated on the Microsoft card, and the enforced provider/method/installation
  switches. The dismissal controls belong to the migration work.
- **No metrics are exported**, and logs carry a safe code rather than structured correlation and
  operation identifiers; both are recorded as outstanding.
- The provider card has **no "test configuration" action**: readiness reports that the fields are
  present, not that the provider accepts them, so a mistyped secret reads as ready until an
  authorization fails at the provider.
- Device-code, browser and API paths are verified by tests against faked providers and a real
  database; **no real Google or Microsoft application was registered**, so the end-to-end
  authorization against the live providers is **NOT RUN** rather than passing.

### Send and attachment limits belong to the transport (P06)

A send used to be measured against one 25 MB total whatever the transport was, which refused a Microsoft Graph
attachment that Graph carries happily through its resumable upload session. The limit that now applies is the
transport's own, computed as `min(installation ceiling, provider ceiling, operation ceiling)`:

- **Microsoft Graph** — one file up to **150 MB** through a resumable upload session (above **3 MB** a file stops
  travelling inline, which is a choice of method rather than a ceiling), and a whole message up to 150 MB. A file
  above the SMTP-era 25 MB is no longer refused, and an interrupted session resumes rather than restarting.
- **Gmail API** — the **raw RFC-822 message** must fit in 25 MB, so the *encoded* message is measured, not the sum
  of the files; a message whose attachments fit but whose encoded form does not is refused as such.
- **SMTP** — no universal limit exists, so the installation's `MAIL_MAX_MESSAGE_BYTES` fallback applies.
- **`MAIL_MAX_ATTACHMENT_BYTES`** — the installation's **hard** ceiling on one attachment and on their total,
  applied whatever a provider would accept; it defaults to the largest file a supported provider carries, so
  configuring nothing does not cap Graph.

Dimensions are kept apart because each names a different refusal — one attachment, their total, the inline images
the composer creates, the composed RFC-822 message, Gmail's raw message, a Graph upload-session file, or the HTTP
request body — and every refusal carries `code`, `dimension`, `actualBytes`, `limitBytes` and `transport` (with the
file name when one caused it), so no client has to match English text. A provider-measured refusal is decided
**before** the durable send intent is claimed: it leaves no uncertain intent and no provider operation behind, and
the same idempotency key retries a smaller message. The composer asks the server for the sending account's limits
and refuses a file it already knows cannot be sent, without closing the composer or discarding the draft. Sending
semantics are otherwise unchanged: one composition, the same durable claim, and an unknown outcome still parked
rather than retried.

**Verification.** `sendLimits.test.ts` (the model, every dimension and the two environment ceilings),
`sendTransport.preflight.test.ts` (Graph accepts above 25 MB; Graph refuses above its own ceiling; Gmail refuses on
the raw message; the render is measured once), `send.limits.test.ts` (the route, end to end, including a 26 MiB
Graph attachment that reaches the provider and a Gmail message refused for its raw size), a real-PostgreSQL case
that a size refusal leaves no `send_idempotency` row and no `provider_operations` row and that the same key retries
successfully, the forwarded cross-transport case (accounted on the sending transport, read from the source
transport), the existing SMTP and Graph suites, and the composer's own contract test across all nine locales. Real
provider acceptance remains **NOT RUN**: every provider call in these suites is faked at the HTTP boundary or the
module boundary against a real PostgreSQL.

## Verification

Measured on the frozen `dev` SHA **`f2b0dbf13594adc454e610d8aa458d581a83bdff`**, with each gate's own exit
status read rather than inferred from a pipeline:

- Backend: typecheck clean, lint clean, **2855 unit tests passed, 180 skipped** (236 files passed, 24
  skipped).
- Frontend: typecheck clean, lint clean, **2705 tests passed, 0 failed**, production build clean.
- Database: a database created empty for the purpose, the **whole 115-migration chain applied from zero**
  by the application's own runner, then **384 integration tests across 41 suites** on PostgreSQL 16 —
  exit 0, including the send-ledger suite that asserts on real rows that a size refusal claims no intent
  and leaves no provider operation behind. (Running the unit suite *and* the integration suites against one
  database in a single process is not a supported combination: independent integration files then contend
  on the same conversation tables and a `SERIALIZABLE` rebuild can hit a serialization failure. The two
  figures above are the separate, supported invocations.)

**Images published from that exact SHA** (documentation-only commits follow it, so the published images are the current `dev` code). Workflow run
[`35471043131`](https://github.com/Dragonk/Inboxora/actions/runs/35471043131) built and pushed the `:dev`
tags from `f2b0dbf1`; both resolve to OCI image indexes carrying `linux/amd64` **and** `linux/arm64`:

- `ghcr.io/dragonk/inboxora-backend:dev` — `sha256:04512c4407e774fbb6d5fe956a6b74511a4755fb9451e8e79c245c2df4f4f20e`
- `ghcr.io/dragonk/inboxora-frontend:dev` — `sha256:87456ed55c4591807a069869aef6e7db0cc4aa600da00cfae28355245fc3660b`

**Runtime smoke of that published pair — RUN, and passed.** The pair was pulled and started as a stack
(PostgreSQL, Redis, ntfy, backend, frontend) from a fresh volume: the backend applied the migration chain
and became healthy, `/api/health` answered `{"status":"ok"}`, **`/api/version` answered
`{"version":"dev","sha":"f2b0dbf13594adc454e610d8aa458d581a83bdff"}`** — the published image is the frozen
revision — `schema_migrations` held all **115** rows, the first user was registered (admin), a fresh cookie
jar logged in through `POST /api/auth/login`, `/api/auth/me` returned that user, `/api/accounts` returned
`[]`, and the UI root served the application. `docker inspect` reported **0 restarts** for every container
and no migration failed.

Not run for this revision, and therefore **NOT RUN** rather than passing:

- The **browser suite** and the documentation screenshots — last measured on the earlier 4.1.0 cut (205
  browser tests across the desktop and phone projects; 30 screenshots referenced and non-empty).
- The **CI jobs on a GitHub runner**: the workflow definitions and every path they reference were checked
  statically and the database job's commands were run by hand against a real PostgreSQL, but the jobs
  themselves have not executed on a runner.
- **Live provider acceptance**: no real Google or Microsoft application is registered, so authorization
  and every provider call against the live services is **NOT RUN**. The DAV server has not been exercised
  with **DAVx⁵**, Thunderbird or a macOS client, and no real mailbox has been cut over to Graph or the
  Gmail API.

Measured on `dev` at `dbf6077b`, with each gate's own exit status read rather than inferred from a
pipeline:

- Backend: **2523 tests passed, 117 skipped** (206 files passed, 14 skipped), typecheck and lint clean.
- Frontend: **2690 tests passed, 0 failed**, typecheck, lint and production build clean.
- Database: **215 integration tests across 21 suites** on PostgreSQL 16, with the full migration chain
  (113 migrations) applied to a fresh, empty database created for the purpose and dropped afterwards.

Not re-run for this revision, and therefore **NOT RUN** rather than passing:

- The **browser suite** and the documentation screenshots — last measured on the earlier 4.1.0 cut
  (205 browser tests across the desktop and phone projects; 30 screenshots referenced and non-empty).
- The **new CI jobs on a GitHub runner**: the workflow definitions and every path they reference were
  checked statically, but the jobs have not executed on a runner.
- **Live provider acceptance**: no real Google or Microsoft application is registered, so authorization
  against the live providers is **NOT RUN**. The DAV server has not been exercised with **DAVx⁵**.
- The **runtime smoke of a published image pair** against `/api/health`, `/api/version` and a basic
  login is **NOT RUN**.

A static review or a mocked test does not stand in for any of the above.

### Gmail API read path, mutations and send (P08)

Verified at the commit that delivered it, each gate's own exit status read:

- Backend `npx tsc --noEmit` and `npx eslint src --max-warnings 0`: clean.
- The full backend unit suite: green, including the new Gmail units in `gmailLabels.test.ts`,
  `gmailMail.test.ts`, `gmailMailBody.test.ts`, `gmailMailMutations.test.ts`, `gmailMailSend.test.ts`
  and `gmailMailTransport.test.ts`, plus the send-seam and bulk-read-dispatch route cases.
- PostgreSQL integration: a fresh database (`inboxora_gmail_gate`) with the full migration chain
  applied, then `gmailMailSync.integration.test.ts` — **9 tests, green** — covering label projection
  and its collection links, label rename and deletion with message re-homing, the baseline and its
  stored `historyId`, an incremental run that applies a mailbox move and a deletion, the `404`
  rebuild with reconciliation, the sync lease, and the paused-baseline resume from its checkpoint.
- PostgreSQL integration suites for the Gmail label/message sync (9 tests) and the message mutations
  (5 tests), both green.
- PostgreSQL integration for the draft mirror (2 tests), green.
- **Real-provider acceptance is NOT RUN**: no live Gmail mailbox was used, so the Gmail REST calls — and
  in particular Gmail's own handling of the `Bcc:` header on a delivered copy and the `Draft`/message
  identity split — are exercised only against faked HTTP responses. That last point is the one an
  operator must not read as verified.
