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

## [Unreleased]

### Changed

- **"Mark all as read" reaches Microsoft Graph** (P07b, tenth slice). The route updated the local rows and
  then asked IMAP to set `\Seen`, so on a native account the interface looked right until the next sync
  brought the unread state back. It now sets the flag on each unread message through the same
  journal-backed write the single read/unread route uses — one mutation per message, since Graph has no
  "mark folder read" call — and the list of messages is taken **before** the local update flips them,
  or it would find nothing. An outcome the provider does not confirm is logged with how many it did
  confirm rather than reported as success.

- **Deleting several Microsoft Graph messages at once works** (P07b, ninth slice). `POST /messages/bulk-delete`
  — the multi-select delete — still called IMAP for both halves: the permanent removal of a draft or an
  already-trashed message, and the move to Trash for everything else. Both now go to the provider, on the
  same shared helpers single-message delete, filing, spam/ham and snooze use, so the rule that a Graph
  move re-identifies the message is still implemented once. The rule that Graph rows must stay out of the
  IMAP delete-and-re-insert statement applies here too, and the counts and the response include them.
  A removal or a move the provider does not confirm is logged and left alone rather than reported as
  done.

- **Snooze works on a Microsoft Graph account, in both directions** (P07b, eighth slice). `/messages/:id/snooze`
  called IMAP's folder creation and move directly, so it failed on a native account; the wakeup half was
  worse, because it lives inside the mail manager and would have sent the message *into* Snoozed and never
  brought it back. Both halves now go through one shared Graph move helper — the same one the bulk routes
  and spam/ham use — so the rule that a Graph move **re-identifies the message** is implemented once. The
  `Snoozed` folder is created on the provider and then discovered, because a Graph account only has the
  folders it has discovered and a move needs a local path to address. A wakeup the provider does not
  confirm throws, so the snooze record survives and the next cycle retries rather than dropping the
  message. The IMAP path, including its UIDPLUS cases, is unchanged.

- **Mark as spam / not spam works on a Microsoft Graph account** (P07b, seventh slice). Both actions
  moved a message by calling IMAP directly, bypassing the transport dispatch every other action now
  has — so on a native account they looked available and failed. They now use the same journal-backed
  move as filing, and the training record and the user's verdict are written **only after the provider
  confirms the move**, so a move that did not happen never becomes a training row. The IMAP path,
  including its UIDPLUS cases and the spam folder mapping it learns, is unchanged.

- **Microsoft Graph messages can be filed** (P07b, sixth slice): **Move to folder** and **Archive** now
  go to Microsoft through the shared provider-mutation layer, and the local row adopts the identity a
  Graph move returns — the mechanism single-message delete introduced, now shared by both bulk routes.
  One destination is resolved per account, once, through the collection link the folder slice created;
  a message the provider refuses is left where it is and reported as not moved, so the interface never
  claims a file that did not happen. A Graph row is deliberately kept out of the IMAP
  delete-and-re-insert statement the bulk routes use: a Graph move re-identifies the message, so that
  statement would delete the row and re-insert it under a UID the provider does not have. **Not yet
  wired:** mark-as-spam and mark-as-ham still use IMAP for every account, so they are not available on
  a native one.

- **The PostgreSQL integration suites and the browser matrix are now part of the `dev` gate.** The two
  layers that found this work's real defects — a lost lease, a two-worker token refresh, a cursor
  advanced out of order, and the drawer that covered the page after a navigation — ran only by hand,
  so a regression could reach `dev` while every gated check was green. `ci.yml` gains a
  `backend-database` job (`postgres:16-alpine`, the migration chain applied to an **empty** database
  with the application's own runner, then the provider and DAV suites), and
  `conversation-v2-playwright.yml` now also triggers on `push: [dev]`. Both workflows set
  `bash -euo pipefail`, so a pipeline's exit status is the real one rather than the last command's.
  **Not verified:** neither job has run on a GitHub runner, so the action versions, cache paths and
  service wiring are unproven; the commands inside them have been executed by hand against a database
  created empty for the purpose, where the chain applied from zero and all 179 integration tests
  passed.

### Added

- **Microsoft Graph message delete (P07b, fifth slice).** Deleting a Graph message follows the same
  product decision the IMAP path already makes — a **draft** and a message **already in Trash** are
  removed for good, anything else is **moved to Trash** — carried out through the shared
  provider-mutation layer. A Graph move **re-identifies the message**, so the local row adopts the new
  provider id and compatibility number rather than being left on a dead one. The provider call runs
  before the local row changes, as it does for IMAP: a row that claims a message is in Trash when the
  provider never moved it is worse than a slower delete. A refused or unconfirmed delete leaves the
  row untouched and answers `409`/`502` rather than reporting success. Move and delete are declared
  **non-idempotent** on purpose — a second attempt addresses an id that no longer exists and answers
  `404`, which cannot be told apart from "gone for another reason" — so a recovered claim is parked as
  `outcome_unknown` instead of being re-run automatically.

- **Microsoft Graph message body and attachments (P07b, fourth slice).** Opening a Graph message now
  reads its body from Microsoft — fetched on demand, sanitised with the same HTML sanitiser the IMAP
  path uses, and cached in the same `body_html`/`body_text`/`attachments` columns, so the reading
  interface needs no branch and later views are served from the cache. **Attachments** are listed with
  their provider metadata and download by their Graph attachment id, under the same 50 MB ceiling the
  IMAP path enforces; a download is refused before the bytes are decoded. **Inline images are
  embedded** as data URIs from their `contentId`, bounded in count and size, which is what keeps the
  cached HTML out of the "unresolved `cid:`" rule that would otherwise re-fetch the body on every view.
  A single unreadable inline image is skipped rather than failing the whole message. The message body
  cache, the remote-image blocking preference and the calendar-invitation marker all behave as they do
  for IMAP.

- **Microsoft Graph message flags, and the pending-mutation drain (P07b, third slice).** Marking a
  Graph message read/unread or starred now writes to Microsoft through the **shared provider-mutation
  layer** — the same `confirmed`/`retryable`/`outcome_unknown` semantics, claim fencing and journal as
  the IMAP flag write — instead of a Graph-only pipeline. A permanent provider refusal (a deleted
  message, a lost scope) **undoes the optimistic local change and answers `409`** rather than leaving
  a state the mailbox does not have; a `retryable` outcome is scheduled in the journal and drained by
  the next message sync, which settles pending flags *before* reading the delta so the sync cannot
  overwrite a change still in flight. This is the drainer the `pending` pool was missing. The IMAP
  path is unchanged.

- **Migration `0109_provider_operation_payload.sql`** adds `provider_operations.payload`, the adapter
  parameters a scheduled retry is re-run with. Without it a `pending` row was unreadable, which is why
  nothing drained the pool. It must be applied **in order, after `0108`, and before the application is
  rolled out**; the column is nullable and no existing row is rewritten.

- **Microsoft Graph mail message sync (P07b, second slice).** A Graph account's message **metadata** —
  subject, correspondents, To/Cc/Reply-To, received date, snippet, read/flagged state, attachment
  flag, and the Graph `conversationId` as the thread — is now ingested into the local `messages`
  table, one delta cursor per folder, refreshed on the provider schedule and by "Sync now". Identity
  is the provider's **immutable message id** (`messages.provider_message_id`), never the RFC
  `Message-ID` and never a hash of it; a `410` from Graph rebuilds the folder from a baseline **and
  reconciles**, so a message deleted while the cursor was unusable does not stay behind for ever. A
  flag the user just changed is not reverted by a sync that read the server earlier (the same 30 s
  local-wins window the IMAP path uses). **Body, attachments and message mutations are not in this
  slice**, and Graph is still not a mail transport: the account continues to read mail over IMAP/SMTP.

- **Migration `0108_message_provider_identity.sql`** adds `messages.provider_message_id` with a
  partial unique index on `(account_id, provider_message_id)` and an index on
  `(account_id, folder)`. It must be applied **in order, after `0107`, and before the application is
  rolled out**; every pre-v4 IMAP row has a NULL provider id and is untouched.

- **Microsoft Graph mail folder discovery (P07b, first slice).** A Microsoft account whose
  `mail_transport` is `microsoft_graph` can now have its mailbox folder tree imported: Outlook's
  well-known folders map onto Inboxora's canonical paths (`INBOX`, `Sent`, `Drafts`, `Trash`, `Spam`,
  `Archive`) with their IMAP-style `special_use`, ordinary folders derive a nested path, and each
  folder is linked to its **immutable Graph folder id** in `integration_collections.remote_id`. A
  folder renamed at the provider is recognised as the same folder: its local path follows and its
  messages are moved with it instead of being orphaned. The folder list is refreshed on the existing
  provider schedule, and "Sync folders" on a Graph account triggers the first discovery.
  This is **folder discovery only** — messages are not imported yet and Graph is not yet a mail
  transport, so the account still reads its mail over IMAP/SMTP.

- **Migration `0107_mail_folder_collection_link.sql`** adds `integration_collections.local_folder_id`
  (nullable, `REFERENCES folders(id) ON DELETE SET NULL`) and a partial index on it. It must be
  applied **in order, after `0106`, and before the application is rolled out**; a collection whose
  value is NULL behaves exactly as before.

- A test for **stored credential encryption**, which was exercised only through mocks: it round-trips with the same key,
  produces ciphertext that does not contain the plaintext, and — the property a backup depends on — is **unreadable with a
  different key** rather than returning the plaintext or silent garbage. It also pins two contracts that were implicit:
  encrypting without a valid `ENCRYPTION_KEY` throws rather than storing plaintext, and `decrypt` throws on a non-string
  instead of returning null.

### Changed

- **Mail flag changes (read/unread, star) now go through the shared provider-mutation layer**, so the IMAP write and
  its outcome are recorded durably in the operation journal before the local bookkeeping runs. Nothing changes for the
  user: a failed or unconfirmed write still leaves the change queued for the background reconciler, and an unavailable
  journal degrades to the previous behaviour rather than failing the action. What is new is that a process stopping
  between the IMAP write and the database no longer leaves the change without evidence.

- **Collection access is now decided by the provider capability model** rather than by comparisons written out at each
  call site. The REST and DAV write guards, the DAV advertised privileges and the contacts list's read-only flag all ask
  one resolver, which combines the origin adapter's declared support with the collection's own access and the device
  password's ceiling. The visible fix is that a **Google or Microsoft address book is now reported read-only** in the
  interface; previously only CardDAV books were, so a synced book looked editable until the server refused the write.
  Behaviour is otherwise unchanged: writes to a provider-owned collection are still refused, because no remote write path
  exists yet, and a read-only collection or a read-only device password still only narrows access.

- After an **uncertain send**, the composer releases its idempotency key, so the user's next deliberate Send is a
  **new operation** rather than a refusal — which is what the plan asks for, together with the duplicate-risk warning
  that is already shown. Nothing sends on its own: this composer dispatches only from a click, and the key exists to
  stop an *automatic* duplicate, so releasing it once the user has been told the outcome is unknown removes no
  protection. Checking the Sent folder remains the first advice, because a duplicate is worse than a delay.

### Added

- Refusals on the forwarded-attachment path now carry **domain codes** rather than only sentences:
  `ATTACHMENT_FETCH_FAILED` when a part cannot be read from the source mailbox — §22.1's rule, which is also §12.9's
  sentence: a retry of the read is possible, and the message is not sent without the file — and `RESOURCE_NOT_FOUND`
  for a referenced message, part or account that is not there. The behaviour is unchanged; what is new is that an
  interface has something to branch on instead of matching English text. The composer now does branch on them and
  renders **translated** sentences with the server's figures — the file name, the actual size and the limit, in units a
  person reads — in all nine languages, rather than showing the server's English.

### Changed

- Two size guards on the send path now answer **`413`** with a domain code instead of `400` with prose only. §22.1 maps
  content that is too large to `413`, and these were the oldest of the checks: the attachment-upload guard reports
  `ATTACHMENT_TOO_LARGE` and the uploads-plus-forwarded total reports `MESSAGE_TOO_LARGE`. The limits are unchanged —
  they still measure the base64 wire size rather than the composed message — so nothing that used to be refused is now
  accepted; a client simply no longer has to match English text to learn what happened.

### Changed

- An **uncertain send** is now reported with a code (`SEND_OUTCOME_UNKNOWN`, the name the plan gives it) rather than
  only an English sentence. The behaviour is unchanged and deliberately so — the message was handed to the server
  and the answer was lost, so Inboxora will not send it again automatically — but a code is what lets an interface
  answer in the user's own language instead of showing the server's text. The composer now does exactly that: it
  recognises the code and says — in all nine languages, as a notification and beside the composer — that the result is
  unknown, that the message will not be sent again automatically, and that the account's Sent folder is the authority.

### Added

- A **message-size ceiling on the send path**, counted on the composed message. The interface's estimate was the
  only check there was, so an oversized message travelled to the SMTP server and failed there with whatever that
  server said. The server now counts the message as actually compiled — headers, base64 growth, separators and CRLF
  included — **before** anything is claimed or dispatched, and answers `413 MESSAGE_TOO_LARGE` with the real byte
  count and the limit. `MAIL_MAX_MESSAGE_BYTES` raises the limit from its 25 MiB default; passing this check means
  this installation accepted the message, **not** that the provider will.
- An oversized **attachment** is named rather than only totalled: the message says which file is above the limit and
  by how much, measured from the decoded contents rather than a declared size. The policy is unchanged — the total
  would have refused the same message — but the administrator learns what to remove.
- A message refused for its **composed size** now reports how much of it is attachments, measured as the raw bytes of
  the decoded files. The third figure the plan asks for — the transport encoding — has no meaning while the only
  transport is SMTP, so it is not reported rather than reported as a zero.


### Added

- A provider configuration can be **tested**, not only reported ready. `POST /api/integrations/:provider/test`
  checks the stored client id and secret against the provider using a deliberately unusable grant: the provider
  answers `invalid_client` when the credentials are wrong and `invalid_grant` when it accepts them, which is the
  whole test and costs the provider nothing. The secret is decrypted for the call and is never part of the answer,
  and no user data or grant is involved. Readiness reports that the fields are present; this reports whether they
  work, which is the difference an administrator with a mistyped secret notices at the provider instead of on the
  card. Each provider card carries a **Test configuration** button for it, which reports which of the two it
  is — accepted, rejected, no client id saved, or the provider unreachable — in place.

## [4.1.0] - 2026-09-19

### Added

- Mobile: open the navigation drawer by dragging right from the left quarter of the visible
  surface. A single gesture owner arbitrates between the drawer, a message-row swipe and
  scrolling, so a partly opened drawer cannot also archive a message. A new
  **Settings → Appearance → "Open the menu with a swipe from the left"** switch (on by default)
  sits directly next to the top/bottom navigation choice and is saved per user; when it is off
  the gesture reserves no start zone. The message reader keeps native text selection.
- Add the v4 provider-layer schema (migration `0101_provider_layer.sql`): provider connections,
  OAuth grants, the per-account calendars/contacts integration switches, the per-account Google
  API recommendation preference, standalone CalDAV/CardDAV/ICS source connections, collection
  metadata, remote object links, a durable provider-operation journal and sync checkpoints. The
  change is expand-only — it creates tables and nullable/defaulted columns and widens the calendar
  and address-book `source` checks without rewriting any existing value, and it never switches a
  transport — so it must be applied before a build that reads the new columns is rolled out; the
  current build continues to work and ignore the new tables. Existing accounts and sources are
  unaffected.
- Add a Google card to the existing **Settings → Integrations → Email providers** screen, next to
  Microsoft and with the same layout (description and setup steps above the fields). It stores the
  Google Cloud Web-application Client ID, client secret and redirect URI, and states explicitly
  that IMAP/SMTP with an app password does not depend on it. There is no Google device-code
  option: Google does not allow a device flow for the Gmail, Calendar and People scopes this
  integration needs. `GET /api/integrations/status` now reports per-method readiness
  (`browser.ready` with the missing field names, and `deviceCode` support) for both providers
  without exposing any credential, so the UI no longer treats a saved Client ID alone as a
  working OAuth client. Config writes are validated against a closed schema, a blank or omitted
  secret preserves the stored one, an explicit clear removes it, and deleting a provider writes a
  tombstone so a restart can no longer resurrect the previous environment values.
- Add recurring events to the calendar. The event dialog can create a daily, weekly, monthly or
  yearly series (interval, selected weekdays, and an end of never / on a date / after a number of
  occurrences); the rule is stored as a standard `RRULE` and included in invitations sent to
  attendees. Editing a recurring event now asks whether the change applies to the occurrence you
  opened or the whole series: the series editor is populated from the series' own start, end and
  rule, and saving applies to every occurrence without disturbing existing exceptions. A foreign
  rule the editor cannot represent is shown as custom and kept untouched unless you explicitly
  replace it. Cancelling already offered *this occurrence / this and following / the whole series*
  and is unchanged. New `GET /api/calendar/events/:id` returns one event's stored representation
  (including its rule) for the series editor, and the `recurrence` field is validated and rendered
  into iCalendar by the server, so a client cannot inject arbitrary iCalendar properties.
- Harden the built-in CalDAV/CardDAV server's discovery and capability surface. CalDAV now
  reports `calendar-home-set` as the calendar home collection instead of pointing at the first
  calendar, so a client (for example DAVx⁵) discovers every calendar instead of only one, and a
  `Depth: 1` PROPFIND on the home lists the member calendars while `Depth: 0` returns only the
  home. Calendar and address-book collections now advertise `current-user-privilege-set` (write
  privileges only for a local, non-read-only collection — a collection synced from an external
  source is advertised read-only, matching what the DAV write handlers accept) and
  `supported-report-set` for exactly the reports implemented. An unrecognised or expired sync token
  now answers `403` with
  `DAV:valid-sync-token` (RFC 6578) instead of `409`, and the `DAV` header no longer advertises
  class 2/3 (LOCK, extended MKCOL), which were never implemented. CalDAV and CardDAV `If-Match`
  now use strong entity-tag comparison (RFC 9110): a weak `W/"…"` validator is rejected with
  `412` even when its value matches, instead of being stripped to a strong comparison.
- Add the v4 sync/operation foundation (migration `0102_operation_journal_and_outbox.sql`, applied
  after `0101`): provider-operation claims with a monotonic generation and lease, sync-run leases
  and ownership columns on `sync_states`, and a `domain_outbox` for idempotent delivery after a
  local commit. New services `providerOperations`, `syncCoordinator` and `domainOutbox` implement
  the journal, lease/fencing and outbox contracts. A restarted or superseded worker can no longer
  complete an operation it no longer owns; an identical retry replays the stored result instead of
  calling the provider again; the same key with different content is a conflict; and an
  unconfirmed outcome is parked for reconciliation rather than retried automatically. Outbox
  delivery is at-least-once with a per-event identity and a bounded retry budget, so a delivery
  retry cannot duplicate a local effect. The migration is expand-only and must be applied before a
  build that reads the new columns.
- Add the server-side Google web OAuth flow (P04 foundation, migration
  `0103_oauth_authorization_flows.sql`, applied after `0102`). `GET /oauth/google` starts an
  authorization-code + PKCE (S256) flow for a chosen purpose — new account, mail migration,
  calendars or contacts — and requests only that purpose's scopes, so adding a mailbox never
  silently enables calendars/contacts. `GET /oauth/google/callback` exchanges the code, resolves
  the Google identity as issuer + subject (never the e-mail address) and stores the provider
  connection plus the encrypted grant. Flow state is stored hashed and single-use in the database,
  so several flows can run in parallel, a restart does not lose a pending flow, a replayed
  callback is rejected, a callback delivered into another session attaches nothing, and a flow
  started under a different Client ID/redirect is not completed. A token response that omits the
  refresh token keeps the stored one, and each grant write bumps its generation. Google device
  authorization is deliberately not offered because Google does not allow these scopes in that
  flow. Selecting the Gmail API as the mail transport remains a separate, explicit migration step.
- Add single-flight OAuth grant refresh (migration `0104_oauth_grant_refresh_lease.sql`, applied
  after `0103`). A short refresh lease names the one worker allowed to call the provider for a
  grant, and every stored token bumps the grant generation, so the write is a compare-and-swap:
  two workers cannot rotate the same refresh token, a worker that lost the race re-reads the newer
  token instead of overwriting it, and a response without a refresh token keeps the stored one.
  A revoked or expired consent (`invalid_grant`) parks the grant as `reauth_required` and stops
  automatic refresh instead of looping. The provider call is never made inside a database
  transaction.
- Add per-collection DAV visibility and mode (migration `0105_collection_dav_mode.sql`, applied
  after `0104`). Each calendar and address book now has a **DAV access** setting — *Disabled*,
  *Read only* or *Read and write* — editable in the calendar's name/colour dialog and the
  address-book dialog. A disabled collection is absent from discovery and answers `404` on every
  direct URL, so knowing an old link does not bypass it; a read-only collection serves reads but
  refuses DAV writes with `403`. The mode is a ceiling: it can only narrow the collection's own
  rights, never widen them, and the advertised `current-user-privilege-set` matches what the
  handlers enforce. Existing collections default to *Read and write*, so an upgrade changes
  nothing, while a collection created by connecting an external CalDAV/CardDAV source starts
  *Disabled* so it is not published implicitly.
- Add a per-application-password DAV ceiling (migration `0106_dav_credential_max_mode.sql`, applied
  after `0105`). When creating a DAV application password under **Settings → DAV access** you now
  choose **Read and write** or **Read only**, and the active list shows each credential's ceiling.
  The credential's mode travels with the request and is intersected with the collection's own
  mode: a read-only password cannot write even to a read-write calendar or address book, it never
  widens one, and the advertised `current-user-privilege-set` reflects the intersection. Existing
  passwords default to *Read and write*, so an upgrade changes nothing.
- Add the Google People contacts read adapter (P09, first slice). `POST
  /api/contacts/providers/google/sync` pulls the signed-in user's personal Google contacts for every
  active Google connection and projects them into one local address book per connection, created
  with `source = 'google'` and DAV access *Disabled*. Contacts are linked by the People resource
  name, never by e-mail, so a renamed contact, a shared address or a contact without an address
  never merges or duplicates; a person the provider reports as deleted is removed locally and its
  link kept as a tombstone. The sync cursor is stored per connection/collection under the P03 lease,
  so only one sync runs at a time and a restarted worker cannot advance it out of order; a cursor
  the provider rejects (HTTP 410) rebuilds the collection from a fresh baseline instead of failing.
  Provider failures are classified (401 → re-authorize, 403 quota versus missing scope, 410 →
  rebuild, 429/5xx → retryable) and one failing connection does not hide the others' results. The
  synced books stay read-only in the app: REST and DAV writes to a non-local contact are refused,
  so no write-back is pretended before it exists. The in-app sync control and the automatic
  schedule arrive with the account-connection UI.
- Wire the Google authorization flow into the interface (P04). The Google card in
  **Settings → Integrations → Email providers** now offers **Connect a Google account** to any
  signed-in user as soon as the browser flow is ready, and explains what an administrator still has
  to configure otherwise; the flow asks only for Google Contacts, because mail and calendars are
  added separately with their own adapters. A completed popup or same-tab callback reports the
  connection instead of opening the Accounts screen (no mailbox is created or migrated), and the
  Contacts page shows a **Sync Google contacts** action, plus a per-run summary of what was added,
  updated and removed, once an account is connected. A new safe status endpoint
  (`GET /api/contacts/providers/google/status`) reports readiness, the connection count and each
  synced book's count and last-sync time without exposing any credential.
- Add the Google Calendar mapping foundation (P09, internal; not yet wired to a route or screen).
  The adapter preserves a recurring series instead of expanding it: a master event keeps its
  `RRULE`/`EXDATE`, a modified instance becomes a `RECURRENCE-ID` override and a cancelled
  instance a `CANCELLED` override, all-day events stay date-valued, and the wall time is written
  with a real `VTIMEZONE` generated from the platform time-zone database, so a DST boundary cannot
  shift a series. A first revision of the generator omitted the baseline component that expanding
  clients need for a date before the first transition, which read such dates an hour wrong; the
  suite now pins both the summer and winter instant. Provider text is escaped and lines folded per
  RFC 5545, and an event without a usable zone falls back to the exact UTC instant rather than an
  undefined floating time.
- Add the Google Calendar read sync (P09). `POST /api/calendar/providers/google/sync` reads the
  signed-in user's Google calendars through the Calendar API and creates one local calendar per
  Google calendar, read-only and with DAV access *Disabled* so nothing is published to a device
  until the user enables it. A recurring event stays one event with one rule and one local
  resource: a modified instance is merged in as a `RECURRENCE-ID` override and a cancelled instance
  as a `CANCELLED` override, while an incremental batch that carries only an override updates that
  component and leaves the rest of the series untouched. Each calendar's cursor is stored under the
  P03 lease, so only one sync runs per calendar and a restarted worker cannot advance it out of
  order; a cursor Google rejects (HTTP 410) rebuilds that calendar from a fresh baseline without
  deleting the local projection first, and one calendar failing does not stop the others. The new
  `GET /api/calendar/providers/google/status` reports readiness, the connection count and each
  imported calendar's event count and last-sync time without exposing any credential. The in-app
  control and automatic schedule arrive with the account-connection interface; the calendar list
  itself already shows the imported calendars.
- Surface the Google calendar pull in the interface. **Settings → Calendar → Manage sources** now
  shows a **Google calendars** section: once an account is connected it offers **Sync Google
  calendars** and reports what the run did (calendars, added, updated, removed, and a partial
  failure when a connection or a single calendar fails); before that it explains where to connect
  an account. The imported calendars appear in the calendar list as soon as the run finishes. With
  this the whole Google slice — connect an account, pull contacts, pull calendars — is reachable
  without calling the API by hand; the automatic schedule is still to come.
- Refresh the Google collections a user has already pulled on a schedule (default every 15
  minutes, `PROVIDER_SYNC_INTERVAL_MINUTES`, `0` disables it). Only collections that already
  exist are refreshed, so connecting an account never starts an import by itself — the schedule
  keeps what you chose to pull up to date instead. Every run is lease-protected, so a scheduled
  pass, a restart and a manual sync cannot run at the same time or advance a cursor out of order;
  a slow pass is never overlapped, and a failure on one connection is logged and retried on the
  next tick without stopping the others.
- Add a Microsoft Graph access-token service (P04/P07 foundation, internal; no user-visible change
  yet). Google and Microsoft now share one refresh path — the single-flight lease, the generation
  compare-and-swap and the re-auth parking — with only the token exchange differing, so the parts
  that must not diverge cannot. Microsoft rotates refresh tokens on most refreshes, so a returned
  token replaces the stored one while an omitted one keeps it; a public client (the device flow)
  sends no client secret, and the tenant id is validated before it is interpolated into the token
  URL so a malformed value can never retarget the request. A revoked consent (`invalid_grant`) parks
  the grant as needing re-authorization instead of retrying in a loop. The `.env.example` no longer
  claims Microsoft Graph is already required for mailboxes: the Graph transport is still to come, and
  Microsoft mail continues to use the existing OAuth2 IMAP/SMTP path until it lands.
- Add the Microsoft Graph provider authorization flow (P07, reachable at
  `/oauth/provider/microsoft`; not yet exposed in the settings screen). Authorization-code + PKCE
  against the configured Entra tenant, with the same protections as the Google flow: the one-time
  state is stored only as a hash and is single-use, the callback is bound to the session that
  started it, a configuration change mid-flow is rejected, and a declined consent or a replayed
  callback cannot complete a flow later. Scopes are per purpose — `mail_migration`,
  `calendar_enable` and `contacts_enable` never imply one another, and a read-only request asks for
  `.Read` rather than `.ReadWrite` — plus `User.Read`, the lowest-privilege Graph scope, which is
  what identifies the account that was just authorized. The identity is read from Graph with the
  token Microsoft returned server-to-server, never from anything the browser supplied. The route is
  deliberately separate from `/oauth/microsoft`, which keeps handling mailbox sign-in unchanged; the
  returned connection is reported as a connection, not as a new account, and creates or migrates no
  mailbox.
- Add the Microsoft Graph contacts connector (P07/P09, reachable at
  `/api/contacts/providers/microsoft/status` and `/sync`; not yet offered in the interface).
  Outlook's default contact folder is read through Graph and projected into one local address book
  per connection, created read-only with DAV access *Disabled*. Contacts are linked by the Outlook
  contact id, never by e-mail; a contact deleted in Outlook is removed locally with a tombstone link.
  Synchronisation uses Graph's delta feed — a baseline first, then changes only — and a delta link
  Graph rejects (HTTP 410) rebuilds the book from a baseline **and reconciles** it, removing what the
  baseline no longer lists, which a plain re-read would silently leave behind. Each connection's
  cursor is stored under the P03 lease, so only one sync runs at a time and a restarted worker cannot
  advance it out of order. Graph failures are classified (401 → re-authorize, 403 → missing scope,
  404, 410 → rebuild, 429/5xx → retryable with Retry-After, after one controlled token refresh on a
  401), and one failing connection does not hide the others' results. Also fixes a real defect found
  while wiring this: both contacts status endpoints listed **every** address book of the user rather
  than the books of that provider, so a Google book could be reported by the Microsoft connector and
  vice versa; each is now scoped to its own connections.
- Offer the Microsoft Graph connector in the interface. The Microsoft card under
  **Settings → Integrations → Email providers** now has **Connect Microsoft contacts**, which
  authorizes Microsoft Graph for contacts only and says so — it never changes or migrates the
  mailbox, and the existing mailbox sign-in stays a separate action beside it. Once connected, the
  Contacts page's address-book menu shows **Sync Microsoft contacts** alongside **Sync Google
  contacts**; the two are offered and reported independently, so an account connected for one
  provider never hides the other, and each run says which account it belongs to and what it added,
  updated and removed.
- Refresh the Microsoft contacts a user has already pulled on the same schedule as the Google ones.
  Until now only Google was refreshed automatically, so a Microsoft book went stale unless the user
  asked again. Readiness is now decided per provider, so an unconfigured Google can no longer stop a
  Microsoft refresh (or the reverse), a provider/collection pair without an adapter yet is skipped
  rather than attempted, and a failure on either side is logged and retried on the next tick without
  affecting the other.
- Honour the WebDAV `If` header on CalDAV and CardDAV writes (P11 hardening, DV19). It is a
  precondition, not a hint, so a syntactically valid condition the server cannot evaluate now
  **fails** instead of being treated as absent — previously an ignored `If` silently stopped
  protecting a client's optimistic-concurrency guard. Entity-tag conditions (`["etag"]`) use strong
  comparison exactly like `If-Match`, state-token conditions (`(<token>)`) are compared against the
  collection's sync token, `Not` negates a condition, conditions inside one pair are AND-ed and
  pairs are OR-ed, and a repeated header is treated as one. A malformed header is a `400`; a
  well-formed condition that is not met, or a valid form not evaluated here (a tagged list, which
  can name another resource), is a `412`.
- Add an operator procedure for the provider APIs (`docs/wiki/Provider-setup.md`, linked from the
  sidebar and the configuration page). It documents what each connector actually reads, the exact
  redirect URIs (`/oauth/google/callback`, `/oauth/microsoft/callback`,
  `/oauth/provider/microsoft/callback`), the environment variables and their fallbacks, the
  delegated permissions per feature, the difference between the Microsoft mailbox sign-in and the
  Graph contact connector, how refresh and re-authorization behave, and a troubleshooting table
  covering the failures an operator actually sees. Every Inboxora-side name, path and variable in
  the page was checked against the code it describes.
- Import contacts from a **vCard (`.vcf`) file** (P10). The address-book menu had a Google CSV
  import; a `.vcf` export from any other client now imports too, including a file that concatenates
  many cards (line endings and folded lines are handled). Unlike the CSV import, which has no
  stable identity and therefore dedupes by e-mail address, a vCard carries a UID — the same value
  DAV clients use — so the import keys on it and re-importing a file updates the existing contacts
  instead of creating a second copy of each. A card without a UID is given one, a block with no
  usable fields is skipped rather than stored blank, and an empty, oversized or card-less file is
  reported instead of importing nothing quietly.
- Import an **iCalendar (`.ics`) file** into a local calendar (P10), from the calendar's appearance
  dialog. The file is split into one resource per UID, so a series and its moved exceptions stay
  together as DAV requires instead of becoming separate events, and the import keys on the UID, so
  re-importing updates the events a calendar already has rather than duplicating every series. An
  event the projection cannot read (for example one whose end precedes its start) is skipped
  instead of stored broken and does not stop the valid events beside it; a file that is not a
  calendar, or that contains no event at all, is reported as a `400`; and a calendar owned by a
  provider or an imported feed refuses the write, because its source is its writer.
- Run one provider refresh shortly after start instead of waiting a whole interval. A restart used
  to leave already-pulled contacts and calendars stale for up to the refresh interval (15 minutes by
  default); the schedule now performs a first pass 30 seconds after start and then keeps to the
  normal cadence, so a restart no longer delays freshness. The delay keeps the pass out of the way
  of start-up, the existing single-flight guard still prevents it from overlapping a running pass,
  and the timer does not hold the process open.
- Show when each contact connector last synced, or that it failed. The contacts page fetched a
  provider's status but only used whether an account was connected, so a connector that had been
  failing — or one that had not run for days — looked exactly like a healthy one. Beside each
  provider's sync action the page now shows the freshest last-sync time across that provider's
  address books, or the recorded error code when a run failed, so a silent problem is visible
  without opening the logs. The status line comes from the payload the page already loaded, so it
  costs no extra request.
- The same for the calendar connector: **Settings → Calendar → Manage sources** now shows the
  freshest last-sync time of the imported Google calendars, or the recorded error code when a run
  failed, so a calendar that stopped updating is visible where the sync action is rather than only
  in the logs. It uses the status payload the dialog already loads.
- Fix a gap in the Google connection card: its single connect button asked only for the contacts
  scopes, so a user who connected from that card could not pull calendars — the calendar sync would
  fail with a missing scope, which the status line above then reported rather than hiding. The card
  now offers **Connect a Google account** (contacts) and **Connect Google calendars** as separate
  authorizations, and its hint explains that each asks for its own feature and that mail is never
  requested there. Google's incremental consent keeps the scopes of the earlier connection, so
  connecting twice accumulates them rather than replacing them.
- Report the right limit when an upload is rejected as too large. The body parser rejects an
  oversized request before any route runs, and its single message named the 25 MB attachment limit
  even for a contacts or calendar import, describing something the user was not doing. The message
  is now chosen from the path: the 900 KB import limit for contact and calendar imports, the 5 MB
  spritesheet limit for the pet import, the attachment limit for sending or saving a draft, and a
  plain "request too large" elsewhere rather than a limit that does not apply.
- Report **when** a connector last failed, not only its error code. A recorded failure now carries
  its timestamp through the status endpoint, and the contacts page and the calendar sources dialog
  show it beside the code, so "it failed" becomes "it failed at 09:12" and a failure that keeps
  recurring is distinguishable from one that happened once during an outage.
- Explain the provider failures a user can act on instead of showing the internal code. A recorded
  failure was reported as its domain code, so a connector that simply needed re-authorizing read as
  `PROVIDER_AUTH_REQUIRED`. A lost or refused authorization, a missing permission, and a provider
  that is throttling now each get a sentence naming the action, in all nine languages. A code with
  no action behind it still shows the raw code, because a friendly sentence for a fault we do not
  understand would be worse than the code itself.
- Confirm what a contact import added. Importing a CSV or vCard file silently refreshed the list, so
  a user could not tell a successful import of forty contacts from a file that matched nothing. Both
  importers now report the count the server returns, in all nine languages, in the same place as the
  sync notices.
- Confirm what a calendar import added, and keep the dialog open to show it. Importing an `.ics`
  file closed the appearance dialog immediately, so the only feedback was the event count changing
  somewhere in the calendar behind it; the dialog now stays open with the count the server returns,
  which also lets a second file follow without reopening it. A previous file's confirmation no
  longer greets the next calendar you open.
- Say when a provider is ready to connect. The contacts page showed nothing for a provider an
  administrator had already configured, so a user could not tell that contact import was available
  to them; it now names the provider and the button to use under **Settings → Integrations**. It
  appears only in the not-connected case and never replaces the sync control for an account that is
  connected.
- Report how much each connector is holding on its last-sync line. The line showed only a time, so
  a connector that had synced but imported nothing looked the same as one holding hundreds of
  contacts; it now names the total across that provider's books or calendars. The date stays the
  freshest sync, so the message says "in total" rather than implying the count belongs to that one
  time — they are different aggregations over the same set.
- Clear a contact import's confirmation when you switch address books. It is shown outside the
  address-book menu, so the previous book's result stayed visible over the next one — the same stale
  confirmation the calendar import no longer shows.
- Return the failure timestamp from the **calendar** status endpoint too. It was added to the
  contacts endpoints only, so the calendar sources dialog had the time interpolated as empty and
  showed a failure as `… ( )` instead of when it happened. Both surfaces now carry it, and a
  real-database case covers the other half of the contract: a run that fails after taking the lease
  records both the code and the time the status line reads.
- Acknowledge the Microsoft Graph connection in the tab that started it. The connect button opens a
  popup, and the popup reports the provider it was redirected with — `microsoft_graph` — which the
  opener had no branch for, so completing **Connect Microsoft contacts** left the card unchanged, the
  button stuck until its timeout, and the Contacts page unaware that an account had just become
  connectable. The Graph connector now gets its own confirmation, distinct from the mailbox sign-in
  because they are different grants.
- Release every connect button when an authorization fails. A failed Google or Microsoft Graph
  consent left that button disabled until its five-second timeout, because only the mailbox button
  was released. The error text still appears in the mailbox area: the popup does not report which
  provider failed, and attributing it to a guess would be worse than leaving it unattributed.
- Make the connector status line's arithmetic robust and tested. The four aggregations (freshest
  sync, total, failure precedence, the action sentence) existed twice, once per surface and only as
  component code that no test could reach. They now live in one helper with unit tests, and it
  de-duplicates rows by collection: the `sync_states` unique key includes `coverage`, so the status
  query could one day return two rows for one collection, and a fan-out would silently double the
  number the line reports. Relying on "only one row exists today" is fine for the query, not for a
  count the user reads.
- Stop the iCalendar import replacing the calendar's DAV sync token. A `calendar_events` trigger
  already maintains it in the `sync-N` scheme the DAV endpoint advertises, and the import wrote a
  random UUID of its own on top — a value that scheme never produces. Removing it also removes a
  redundant statement per import. Verified on a real database that inserting an event bumps the
  token and that it stays in the advertised form, which is what the DAV clients depend on.
- Make the Microsoft connector's readiness mean what the hint promises. The contacts status
  reported *configured* when only a client id existed, which is enough to refresh a stored token but
  not to run the browser authorization — so a user could be invited to connect an account through a
  card that would fail at Microsoft. The status now uses a browser-flow predicate (client id, secret
  and redirect URI), while the **sync** action keeps the looser one, because refreshing a grant needs
  no secret. Both predicates are pinned by tests so the distinction cannot collapse.
- Give the Microsoft Graph authorization its own callback. Both Microsoft flows read
  `MS_REDIRECT_URI`, which belongs to the mailbox sign-in, so the connector asked Microsoft to
  return its authorization code to `/oauth/microsoft/callback` — a route that knows nothing about
  the connector's state. The connection could therefore never complete in a real installation. The
  connector now uses `/oauth/provider/microsoft/callback`, derived from the trusted `APP_URL` (or
  from `MS_PROVIDER_REDIRECT_URI` when set), and the readiness flag that offers the connect action
  requires that callback rather than the mailbox one.
- Ask only for the access these connectors use. Both connect buttons requested write scopes —
  `contacts`/`calendar.events` on Google, `Contacts.ReadWrite` on Microsoft — while every adapter
  reads. A permission the software never exercises is one the user cannot see a reason for, and it
  widens what a leaked grant can do. The buttons now send `access=read_only`, which the server
  already honours by narrowing the scope, and both ends are pinned by tests so the consent screen
  cannot silently widen again.
- Fix the mobile drawer staying open over the page after navigating. Handing styling back to React
  cleared the drawer's inline `transform` instead of restoring it, and React does not re-apply a
  style it has already committed — so after a navigation click (which also fires `blur` and aborts
  the gesture sequence) the drawer rendered at its layout position, covering the content it had just
  navigated to, even though the state said closed. Found by running the end-to-end suite, which had
  not been part of the gates.
- Stop an `.ics` import overwriting an event Inboxora owns. The import upserts by UID, and it
  lacked the guard the CalDAV write path applies: an event kept in sync because Inboxora sent its
  invitations could have been replaced by a file — organizer, attendees and all — silently, which
  a DAV client is explicitly refused. Those conflicts are now left unchanged and reported, and a
  file whose events are all protected is no longer described as containing none.
- Close a window in which a grant could be refreshed twice. A successful store releases the refresh
  lease, so a worker that had read an expired token *before* another worker stored a fresh one could
  still acquire the now-free lease and call the provider again with the token it read earlier.
  Harmless where the provider keeps its refresh token, but a real risk where it rotates it — the
  second exchange can invalidate the first worker's result. The grant is now re-read under the lease
  and a token that has since become usable is returned instead of refreshing again.
- Report a revoked authorization as what it is. The providers' token service throws its own error
  type, which the connectors did not recognise, so the one failure a user can act on — reconnect the
  account — was recorded as `INTERNAL_ERROR` and the message written for exactly that case never
  appeared. Their codes are now recorded (and `invalid_grant`, `unauthorized_client` and a missing
  refresh token are mapped to the "reconnect the account" sentence), so a revoked consent reads as
  an action instead of an internal fault.
- Stop a provider refresh switching a disabled collection back on. Each connector re-asserted
  `enabled`, its access columns and its DAV mode on every run, so a collection that had been turned
  off — which the refresh schedule honours — would be silently re-enabled by the next sync of that
  connection. The refresh now only links what is missing and leaves the settings it does not own
  alone.
- Stop promising an automatic retry that may not happen. The message shown when a provider is
  throttling said the sync "will be retried automatically", which is only true while the refresh
  schedule is enabled — and the same documentation that describes this message documents setting
  `PROVIDER_SYNC_INTERVAL_MINUTES=0` to disable that schedule. The wording now tells the user to try
  again shortly, which is true either way, instead of describing behaviour the operator may have
  turned off.
- Stop telling a user who connected Google calendars to sync their contacts. The same confirmation
  is shown after authorizing either Google purpose, and it named the contacts page specifically, so
  the instruction was wrong for the calendar button. It now states what happened; each surface
  already offers its own sync action, so naming one was both redundant and, half the time,
  incorrect.
- Offer the Microsoft contacts connector wherever it can actually run. The button was gated on the
  mailbox sign-in's readiness, which needs `MS_REDIRECT_URI` — a callback the connector does not use,
  because it authorizes on `/oauth/provider/microsoft/callback` derived from `APP_URL`. An
  installation that had a working connector but no mailbox sign-in therefore hid the button, while
  the Contacts page's hint (which uses the connector's own readiness) invited the user to press it.
  The status now reports the connector's readiness separately and the card uses it, so the hint and
  the button agree.
- Stop offering the *Connect* button for a Microsoft sign-in that cannot complete. It was enabled as
  soon as a Client ID existed, but the browser method needs a confidential client — a secret and the
  exact redirect URI — and clicking with only a Client ID failed at Microsoft. A Client ID alone is
  enough for the device-code method, which keeps its own control; the browser button now requires
  the browser readiness the status already reports, so it is offered only where it can work.
- Make the Microsoft device-code switch mean something where it is used. The device button was
  enabled whenever a Client ID existed, so switching the method off in the saved configuration left
  it fully usable — the readiness text said one thing and the control did another. The button now
  follows the device method's own readiness, like the browser and connector controls do for theirs.
- Enforce the Microsoft device-code switch on the server, not only in the interface. The method's
  readiness was reported and the button honoured it, but `POST /oauth/microsoft/device` still started
  the flow for a method an administrator had switched off — so the setting was effective for users and
  decorative for any caller that bypassed the interface. The route now answers `403` with a clear
  message, and a configuration that cannot be read leaves the method enabled rather than failing
  closed.
- Make the provider and per-method switches real. `enabled` per provider and `webEnabled` /
  `apiEnabled` per method were stored and partly displayed, but nothing enforced them: switching
  Google or Microsoft — or one of their methods — off left every flow startable, and the readiness
  card still reported the provider as enabled. The stored switches are now read by the flows
  themselves (both Microsoft authorizations, the device method and the Google authorization), the
  readiness report reflects them, and both halves are covered by tests, because a report that says
  "unavailable" over a route that still works is the same defect in the other direction.
- Allow a connected provider account to be disconnected. An authorization could only be undone at
  the provider: nothing wrote `revoked`, and no route existed to remove a connection. `POST
  /api/integrations/provider-connections/:id/disconnect` now revokes the grant, **deletes the stored
  access and refresh tokens** rather than leaving them encrypted at rest, takes the connection out of
  service so no schedule touches it, and disables its collections so nothing refreshes. It deletes
  none of the imported data: that is the user's, it stays visible, and removing it is a separate
  decision rather than a side effect of disconnecting. Only the owner's own connection is affected.
- Show what is connected and let it be disconnected. The integration card listed nothing about the
  accounts a user had authorized, so a connection could only be undone through the API or at the
  provider. The card now lists the signed-in user's own connections per provider and offers
  **Disconnect** for each, and the status endpoint reports them (ids only, never a credential,
  owner-scoped). Disconnecting keeps the imported data, as the endpoint documents.
- Make reconnecting after a disconnect actually refresh again. Disconnecting disables a
  connection's collections, and re-authorizing the same account re-enabled the connection but not
  them — so the connector came back into service with nothing to refresh, which is indistinguishable
  from a connector that never worked. Re-authorization now re-enables the collections as well.
- Say what Microsoft requires. The integration status has reported a mail policy since it existed —
  Microsoft requires an API-based connection, Google recommends one — and the Google recommendation
  was already stated in that provider's own description, but nothing in the interface said that
  Outlook.com and Microsoft 365 no longer accept a mailbox password. The Microsoft card now states
  that requirement, so the person choosing knows the connection is the only option.
- Tell a DAV client why a write was refused. A collection Inboxora keeps read-only — because its
  source writes it, or because its DAV mode says so — answered `403` with no body, which a client
  cannot tell apart from a permissions failure and a user cannot read in a log. The refusal now
  carries a `DAV:error` body naming the reason, on both protocols and on the create/update and delete
  paths.
- Answer a `PROPPATCH` instead of falling through. Clients such as Thunderbird and DAVx5 set a
  collection's display name or colour that way, and nothing handled it, so the request reached the
  framework default — which a client receiving it on a collection that exists has every reason to
  read as "the collection is gone". Both protocols now refuse it with a `DAV:error` body saying that
  properties are managed by Inboxora, and the refusal writes nothing.
- Bound the CalDAV and CardDAV request body. Those routes read their own bodies, and nothing capped
  them: the application's JSON body limit does not apply to XML, calendar and vCard content types, so a
  client with a device password could make the process hold an arbitrary body in memory on the
  endpoints that serve everyone else. The body is now capped at 1 MB, excess is discarded rather than
  buffered, and an oversized request is refused with the same route-aware `413` message an oversized
  JSON upload already gets.
- Bound the identity provider's response while signing in through OIDC. The route accumulated that
  response in memory with no cap, the same shape as the DAV body fixed above; the provider is configured
  by the operator and answers in kilobytes, but a compromised or misconfigured one could have made the
  process buffer an arbitrary reply. The response is now capped at 1 MB and a larger one is refused
  rather than held, with a case that serves an oversized reply and asserts the refusal.
- Carry anniversaries and instant-message handles from Google contacts. The connector asked the People
  API for neither, so both were discarded even though the contacts table has had columns for them — and
  for the vCard import — all along. The request now includes `events` and `imClients` and both are
  mapped, so a Google contact arrives with what it holds. Photos and group memberships are still not
  carried, and the wiki says why.
- Carry anniversaries and instant-message addresses from Microsoft contacts too. The Graph connector
  never asked for `anniversary` or `imAddresses`, so both were discarded like their Google counterparts
  were — the same columns sat empty for the same reason. Graph's anniversary uses the same timestamp
  shape as its birthday, and a bare IM address carries no protocol, so it is typed `other` rather than
  guessed at.
- Add one switch for the whole provider layer. `PROVIDER_INTEGRATIONS_ENABLED=0` (or `false`, `off`,
  `no`) makes an installation stop offering and stop accepting every provider authorization — no Google,
  no Microsoft mailbox, no device method, no contacts connector — while leaving the per-provider and
  per-method switches to say which parts a *configured* installation offers. Unset means enabled, so an
  existing installation sees no change. The interfaces and the flows read the same switch, so the card
  cannot offer what a flow would refuse.
- Say when connecting an account fails, and say what to do. A provider authorization that failed in the
  same tab cleared the URL and reported nothing, so the only sign of it was that nothing happened; in the
  popup it printed the raw provider code, `invalid_grant` included, when the sentence written for exactly
  that case already existed. Both now map the code to that sentence — "the connection needs to be
  reconnected" — and show the code itself when there is no wording for it, so nothing is hidden.
- Make `PROVIDER_INTEGRATIONS_ENABLED=0` reach the sync paths. The switch stopped the authorization flows
  and the readiness report from offering anything, but the provider sync routes and the scheduled refresh
  call the adapters directly — so an installation that had switched the layer off could still call out to a
  provider for collections it had pulled earlier. Both now refuse: the routes answer `403`, and the schedule
  reports a run of nothing rather than an error, since it is not a user action.
- Keep two Microsoft device-code flows apart. They were stored under the signed-in user, so starting a
  second one — another mailbox, while the first was still pending — silently replaced the first: its poll
  reported the second flow's state and completing its code was invisible. Each flow now has an id, the
  client polls with it, and the entry records its owner so another session still cannot reach it.
- Warn before changing a provider's Client ID. The stored secret belongs to the client it was issued for, and
  the API deliberately keeps an omitted secret so that editing a redirect URI does not mean retyping it — which
  meant a new Client ID was silently paired with the old secret, and the mismatch appeared only when the
  provider refused it. Both cards now ask first, unless a new secret is being supplied, which resolves the
  pairing by itself.
- Stop the device-code endpoint being a way to make the server hammer the provider. Every poll of that endpoint
  is a call to Microsoft's token endpoint; the interface respects the interval Microsoft asks for, but nothing
  enforced it, so any other caller could poll as fast as it liked. A poll that arrives before the interval has
  passed is now answered from the flow's own state, without calling the provider — the same answer Microsoft
  gives for `slow_down`, at no cost to it.
- Back the refresh schedule off when a provider throttles. `Retry-After` was parsed and recorded by the
  classifiers, but the schedule ran at a fixed interval, so a throttled collection was retried on the same
  cadence as a healthy one — which is the behaviour a provider is least willing to forgive. A throttled pass now
  doubles the wait towards a thirty-minute ceiling with jitter, so a fleet of installations does not retry in
  lockstep, and a healthy pass returns to the normal cadence.
- Let the recurrence projection decide a CalDAV time-range query. The query used `OR recurring` to select
  candidates — an indexed form of the old raw-text check — and then returned every candidate, so a series whose
  rule never lands inside the requested window came back anyway and the client received resources it had not asked
  for. Candidates are now filtered by their actual occurrences in the window, which is also what makes the filter
  correct across daylight-saving changes and overrides rather than approximately right.
- Dispatch a DAV report by its root element, not by a substring of its body. The handlers recognised
  `calendar-query`, `calendar-multiget`, `sync-collection` and their CardDAV counterparts with `body.includes`,
  so a multiget naming a resource whose filename contains another report's name was read as that report. The root
  element now decides, with the XML declaration and any comment skipped first, which is what the request actually
  is.


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

### Added

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
