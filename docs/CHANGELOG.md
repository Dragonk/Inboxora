# Changelog

All notable changes to Inboxora are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For the narrative version — what the release means, what to expect when upgrading, and the known
limitations — read the matching page in the Wiki: [Release notes 4.0.4](wiki/Release-notes-4.0.4.md),
[Release notes 4.0.3](wiki/Release-notes-4.0.3.md),
[Release notes 4.0.2](wiki/Release-notes-4.0.2.md),
[Release notes 4.0.1](wiki/Release-notes-4.0.1.md) and [Release notes 4.0.0](wiki/Release-notes-4.0.0.md).

## [Unreleased]

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
