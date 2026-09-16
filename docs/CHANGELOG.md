# Changelog

All notable changes to Inboxora are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For the narrative version — what the release means, what to expect when upgrading, and the known
limitations — read the matching page in the Wiki: [Release notes 4.0.2](wiki/Release-notes-4.0.2.md),
[Release notes 4.0.1](wiki/Release-notes-4.0.1.md) and [Release notes 4.0.0](wiki/Release-notes-4.0.0.md).

## [4.0.2] - 2026-09-15

### Fixed

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
