# Changelog

All notable changes to Inboxora are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For the narrative version — what the release means, what to expect when upgrading, and the known
limitations — read the matching page in the Wiki, for example
[Release notes 4.0.0](wiki/Release-notes-4.0.0.md).

## [Unreleased]

### Added

- **Separate light and dark theme defaults** — choose the theme used in the light appearance and
  the theme used in the dark appearance independently, and select a theme mode that follows the
  system colour scheme or forces light/dark. **Ink** is the default light theme and the new
  **Dark ink** is the default dark theme, so a fresh profile follows the system out of the box.
  A single theme chosen before this change is preserved as an explicit choice for its appearance.

### Fixed

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

### Changed

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

### Performance

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

### Added

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

### Known limitations

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

## [4.0.0]

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
- **Platform** — installable PWA with an unread badge and Web Push; Electron and Android/Capacitor
  shells under stabilisation.
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

## [3.4.0]

The upstream-era release line that 4.0.0 supersedes. See the git history for changes before this
changelog existed.
