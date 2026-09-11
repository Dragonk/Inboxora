# Inboxora v4 — Calendar, Contacts, DAV, Mobile and Settings Feature Inventory

Source material for the README and GitHub Wiki. Every statement below was read from the
`dev` branch source; file references are given where the behaviour is non-obvious.
Items marked **[beta]** or **[opt-in]** need explicit action to enable; items marked
**[config]** require server- or admin-side configuration.

---

## 1. Calendar

### 1.1 Calendars and views
- Users can create, rename, recolor and delete multiple **local, writable** calendars; deletion requires typing the calendar name. The list also returns the generated read-only `contacts-birthdays` calendar (`backend/src/routes/calendar.js:315-401`).
- Views are **month, week, work week and agenda**; on mobile they are a `<select>`, on desktop a segmented control (`frontend/src/components/CalendarPage.jsx:265-269`).
- Month view renders a fixed 42-day grid including adjacent-month days; week view shows 7 days; work-week shows only the configured work days, sorted from the configured first day of week (`CalendarPage.jsx:34-42`).
- Agenda view lists the active month's events grouped by day, all-day first (`CalendarPage.jsx:283`, `frontend/src/components/CalendarAgenda.jsx:12-20`).
- A **day agenda** panel sits beside the grid on wide screens and opens as a bottom sheet on compact/mobile layouts (`CalendarPage.jsx:287,290`).
- The time grid draws a 24-hour axis, a working-hours band, a "now" line, a sticky day header and side-by-side layout of overlapping timed events (`CalendarPage.jsx:358-393`, `frontend/src/components/calendarView.js:186-291`).
- Month cells show at most 3 events plus a "+N more" chip that opens the day (`CalendarPage.jsx:333-346`).
- The mini-month in the sidebar navigates the anchor date in every view (`frontend/src/components/CalendarSidebar.jsx:158-168`).
- Events are fetched for the visible range only and requests are aborted on range change/unmount; the server rejects ranges over **366 days** (`CalendarPage.jsx:136-165`, `calendar.js:19-20`).
- Every event opens a **preview dialog first**; editing is one action away (`CalendarPage.jsx:227-234`).

### 1.2 Recurrence, time zones, all-day and multi-day
- Recurrence is expanded server-side with ical.js from the original `DTSTART`; `RRULE` and `RDATE` series are supported (`backend/src/utils/calendarRecurrence.js:71-163`).
- `RECURRENCE-ID` overrides and cancellations are projected individually; `STATUS:CANCELLED` occurrences are hidden (`calendarRecurrence.js:93-99,155-160`).
- Recurrence expansion is bounded (default 100 000 iterations, deadline/abort aware) and runs in a worker pool off the request thread (`calendarRecurrence.js:6,71-77,130-136`, `backend/src/services/calendarProjectionPool.js`).
- If a series cannot be fully expanded, the response reports `truncated: true` with per-series reasons and the UI shows an "incomplete series" notice instead of silently showing a partial month (`calendar.js:461-472`, `CalendarPage.jsx:279`).
- Editing or deleting a recurring event **edits only the selected occurrence**; the dialog states this explicitly (`CalendarPage.jsx:189,404`, `calendar.js:569-591`). Creating new recurrence rules in the UI is not supported.
- Editing an occurrence merges values back into the stored VCALENDAR, preserving the rule, `EXDATE` and sibling instances (`calendarRecurrence.js:167-194`).
- All-day events use `VALUE=DATE`; a multi-day event spans every day from its start up to (exclusive) its end (`calendarView.js:85-88,162-169`).
- All-day and timed values round-trip through `date` / `datetime-local` inputs and toggle correctly when the all-day checkbox changes (`calendarView.js:99-135`).
- Timed events carry the browser's IANA time zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) and it is stored per event (`calendarView.js:149`, `calendar.js:477`).
- Stored `TZID` values and `VTIMEZONE` blocks are resolved when projecting occurrences, so imported zones display at the correct local time (`calendarRecurrence.js:44-48,86`).

### 1.3 Event editor and description rendering
- The event dialog edits title, all-day, start/end, calendar, location, description, URL, organizer, attendees and sender account (`CalendarPage.jsx:396-418`).
- The description is rich text edited with a WYSIWYG editor and rendered in the preview through the same sanitized, script-free mail-body pipeline (`MessageBodyRenderer`) (`CalendarPage.jsx:410,316`).
- Plain-text descriptions sent by other clients are linkified into paragraphs; HTML descriptions (`X-ALT-DESC` or markup) render as HTML (`frontend/src/utils/richText.js:76-85`).
- Stored descriptions keep a plain-text `DESCRIPTION` plus `X-ALT-DESC;FMTTYPE=text/html` when markup is present, so plain clients still read them (`backend/src/utils/richText.js:69-79`).
- An event URL is only rendered as a link when it is `http(s)` (`CalendarPage.jsx:317`, `frontend/src/utils/contactLinks.js:1-9`).

### 1.4 Invitations sent by email
- Invitations are sent from an explicitly chosen, enabled account that has SMTP configured; without one the send option is refused (`calendar.js:483-498`, `CalendarPage.jsx:413-414`). **[config: SMTP account]**
- The invitation is a separate email with an `invitation.ics` attachment (`text/calendar; method=REQUEST`), `ORGANIZER` set to the sending account and `SEQUENCE` incremented on each change (`backend/src/services/calendarInvitation.js:36-73`).
- Removing attendees or changing the sender sends a `METHOD:CANCEL` message to the affected attendees only (`calendar.js:196-211,639-657`).
- Deleting an invited event cancels the invitation first; if cancellation fails the delete is refused with 502 rather than leaving a dangling invitation (`calendar.js:691-713`).
- Sending uses an **idempotency key** (`X-Idempotency-Key`); an identical retry does not duplicate the event, and an undelivered invitation is actually resent on retry (`calendar.js:153-215,500-543`, `frontend/src/components/calendarInvitationRetry.js`).
- Sending is transactional: event plus outbox row are committed together, so a failed transaction keeps no partial changes (`calendar.js:504-531`).
- The response reports `invitationStatus` (pending/sent/failed) and an error message; the dialog shows a **Retry save** button while delivery is pending (`CalendarPage.jsx:195-207`, `calendar.js:169-175`).
- A **default invitation sender** can be preselected in Settings → Calendar; a stale/dead account is ignored (`CalendarPage.jsx:181-188`, `AdminPanel.jsx:1563-1570`).

### 1.5 Invitations received by mail
- Messages containing a calendar part show an **ICS invitation card** in the reader with summary, time, location, organizer and the rendered description (`frontend/src/components/CalendarInvitationCard.jsx:35-48`).
- Only `METHOD:REQUEST` and `METHOD:CANCEL` are accepted; malformed or other methods are rejected during parsing (`backend/src/services/inboundCalendarInvitation.js:117-120`).
- "Add to calendar" copies the event into a chosen writable local calendar as a **local copy that does not send a reply to the organizer** (`CalendarInvitationCard.jsx:41-45`, `calendar.js:285-313`).
- The copy is scoped by UID + organizer + recurrence-id, so repeated invites update the same local event instead of duplicating it, and an older `SEQUENCE` never overwrites a newer one (`calendar.js:294-311`).
- A `CANCEL` invitation is shown as cancelled text rather than offering an add action (`CalendarInvitationCard.jsx:41`).
- If the invitation captured at sync time is missing or unparsable, the server fetches the raw `.ics` MIME part from IMAP and parses it as a fallback (`calendar.js:235-275`).
- Events added from mail retain a link back to the originating message; "Open original message" jumps to it even when it sits in another account or folder (`calendar.js:428-437`, `CalendarPage.jsx:238-246,304`).

### 1.6 Contact-dates calendar
- Birthdays and anniversaries stored on contacts appear automatically as all-day yearly events in the read-only **Contact dates** calendar (`calendar.js:53-84,444-454`).
- Both legacy `birthday`/`anniversary` columns and the richer labelled `contact_dates` list are included, de-duplicated by label + date; custom labels become the event title prefix (`calendar.js:55-79`).
- Partial dates without a year (`--MM-DD`) are supported and recur in every matching year (`calendar.js:67,71-74`).
- The calendar can be renamed and recolored per user; the appearance is stored in the user's preferences and the built-in name is translated unless overridden (`calendar.js:228-231,366-373`, `frontend/src/utils/contactDateLabels.js:12-19`).
- The contact calendar can be hidden by the user's visibility filter like any other calendar (`calendar.js:324`).

### 1.7 Per-user visibility, filters and persisted layout
- Per-user calendar visibility filters are persisted server-side (`visibleCalendarIds`); `null` means "all calendars" and an explicitly empty list means "none" (`calendar.js:25-42`, `auth.js:830-832,869`).
- The selection is sent to the server so unselected series are never expanded (`CalendarPage.jsx:135,143-147`).
- First day of week (Monday/Sunday), work days (0–6) and working-hours start/end (HH:mm, strictly increasing) are per-user settings with server-side validation (`AdminPanel.jsx:1531-1562`, `auth.js:824-867`).
- The active view (month/week/workweek/agenda) is remembered **per device** in `localStorage` (`frontend/src/utils/calendarPreferences.js:7-33`).
- The list/rail width is shared between Mail, Contacts and the Calendar rail; the day-agenda column keeps its own independent persisted width (`frontend/src/utils/panelWidth.js:1-18`).

### 1.8 External CalDAV and ICS/webcal sources (read-only pull)
- Sources of kind **CalDAV** or **ICS/webcal** can be added, listed, manually synced and deleted from Calendar → Manage sources (`CalendarSidebar.jsx:186-196`). **[config: source reachable from the server]**
- CalDAV sources require a remote username and password; ICS sources require only a URL (`calendar.js:738-741`).
- Stored source URLs and passwords are **encrypted at rest** and never returned by the API; sync error text is redacted of URL secrets (`calendar.js:718-727,760-762`).
- `webcal:` URLs are normalised to `https:`; URLs containing credentials are rejected; hosts are validated against the admin connection policy, and public sources must use HTTPS (`calendar.js:742-754`).
- Sync interval is clamped to 15–1440 minutes (default 60) and each source is scheduled independently (`calendar.js:755`, `externalCalendarSync.js:188-191`).
- Remote data is **pull-only and never modified**; a source's projection lives in a read-only calendar named after the source (`externalCalendarSync.js:3-4,79-99`).
- Remote events are stored per UID and events absent from the feed are removed, so the local projection tracks the remote calendar (`externalCalendarSync.js:131-148`).
- A wholly unsupported response never deletes a healthy projection; unsupported VEVENTs are skipped and reported as a counted warning with samples (`externalCalendarSync.js:116-153`).
- A validated empty remote collection does remove the previous projection (`externalCalendarSync.js:117-118`).
- Source status (last sync, last error category, skipped count, diagnostic details) is shown per source, and one failing source does not block others (`CalendarSidebar.jsx:200-206`).
- Deleting a source removes only the local projection, not the remote calendar (`calendar.js:788-808`).

### 1.9 Secret ICS feeds (read-only sharing)
- Any set of owned calendars can be published as an anonymous `.ics` link with a secret token; feeds can be listed, revoked and **rotated**. The anonymous endpoint validates the token shape before hashing, answers every failure identically to prevent enumeration, rate-limits failures and supports `ETag`/`304` (`backend/src/routes/calendarFeed.js:23-87`).

---

## 2. Contacts

### 2.1 Address books and vCard fields
- Multiple **local address books** can be created, renamed, hidden/shown and deleted (at least one must remain); CardDAV-sourced books appear read-only and cannot be renamed or deleted locally (`backend/src/routes/contacts.js:100-152`, `frontend/src/components/ContactsPage.jsx:449`).
- Stored and exposed vCard fields: display name, first/last name, typed emails (first = primary), typed phones, organisation, title, role, nickname, URLs, instant messages, categories, structured addresses (PO box, extended, street, locality, region, postal code, country, typed), notes, `BDAY`, `ANNIVERSARY` and additional labelled `X-ABDATE` dates (`contacts.js:192-210`, `backend/src/utils/vcard.js:245-334`).
- Photos are parsed from and written to `PHOTO` and served from `GET /api/contacts/photo?email=` with a 24 h private cache; the importer also keeps the Google source columns in `google_fields` (`vcard.js:334`, `contacts.js:227-262,345`).
- The client falls back to the stored vCard when a rich column is empty, so CardDAV-written fields (title, role, nickname, urls, addresses, IMs, categories) surface without a re-import (`contacts.js:373-378`).

### 2.2 Contact editor
- The editor covers names, organisation, title, role, nickname, multi-value emails/phones/URLs/instant messages, structured addresses, comma-separated categories, notes and dates (`frontend/src/components/ContactsPage.jsx:880-1056`).
- Emails and phones are typed (other/work/home; phones also mobile) and each row can be added or removed (`ContactsPage.jsx:949-1005`).
- Contact dates support presets **Birthday / Anniversary / Name day** plus a free-form custom label, with multiple entries per contact; dates without a year use `--MM-DD` and render without a year (`ContactsPage.jsx:929-944`, `frontend/src/utils/contactDateLabels.js:40-46`).
- Saving derives the display name from first/last name when it is left blank, and a name or email is mandatory (`ContactsPage.jsx:338-341`, `contacts.js:415-417`).
- Sending an email from a contact opens the Inboxora composer preaddressed to that address from the email row or the Compose button (`ContactsPage.jsx:801,859-874`).

### 2.3 Import, export and search
- **Google CSV import** into a local book, file ≤ 900 KB, upserting by primary email so re-imports update instead of duplicating (`contacts.js:332-351`); the parser reads names, multiple typed e-mails, phones, addresses, websites, IMs, organisation/title/department, nickname, notes, labels/groups, birthday and `Event` dates (`backend/src/utils/contactTransfer.js:87-163`).
- **Export** per address book as **Google CSV**, **Outlook CSV** or **vCard 3.0**; CSV export prefixes formula-leading cells with `'` to stop spreadsheet formula execution (`contacts.js:315-330`, `ContactsPage.jsx:450-452`, `contactTransfer.js:3-9`).
- Search matches display name, primary email, organisation, all stored emails and all stored phones, is debounced by 300 ms, and keeps the query when switching books (`contacts.js:166-176`, `ContactsPage.jsx:188-196`).
- Results are paginated 100 at a time with infinite scroll and a total count, ordered auto-contacts last then most-emailed then alphabetical (`ContactsPage.jsx:72,228-249`, `contacts.js:159,205-208`).
- Hidden address books are excluded unless explicitly selected (`contacts.js:184-189`). **[config: per-book visibility toggle]**
- **Auto contacts** discovered from received mail are marked with an "auto" chip and a hint; contacts from a CardDAV book cannot be edited or deleted locally (403) (`ContactsPage.jsx:541,768-770`, `contacts.js:482-484,582-584`).
- Gravatar avatars are an **opt-in** server-side proxy that hashes the address and caches results; the feature is off unless the user enables it. **[opt-in]**

---

## 3. DAV (CardDAV / CalDAV)

- CardDAV is served at `/carddav`, CalDAV at `/caldav`, and RFC 6764 discovery redirects `/.well-known/carddav` and `/.well-known/caldav` with HTTP 308 (`backend/src/index.js:235-241`).
- DAV authenticates with HTTP Basic using **dedicated, revocable application passwords only**; primary account passwords are explicitly rejected so TOTP and SSO-only accounts still work (`backend/src/services/davCredentials.js:1-24`). **[config: create a DAV application password]**
- Application passwords have the form `mf_dav_<uuid>.<secret>`, are stored as a bcrypt hash, are labelled (1–120 chars), list their created/last-used time, and can be revoked; creating one returns the secret exactly once with a copy-once warning (`backend/src/services/davAppPasswords.js:5-71`, `backend/src/routes/davCredentials.js:12-34`).
- The **DAV access** admin tab documents DAVx5 setup (username = Inboxora username, password = the generated app password).
- OPTIONS advertises `DAV: 1, 2, 3, calendar-access` for CalDAV and `1, 2, 3, addressbook` for CardDAV (`caldav.js:104-109`, `carddav.js:134-139`).
- CalDAV serves PROPFIND discovery (root, principal, calendar home set, calendar collections), REPORT with `calendar-query`, `calendar-multiget` and `sync-collection`, plus GET/PUT/DELETE of `.ics` resources (`caldav.js:111-315`).
- CardDAV serves PROPFIND principal/books (Depth 0 and 1), REPORT with `addressbook-query`, `addressbook-multiget` and `sync-collection`, plus GET/PUT/DELETE of `.vcf` resources (`carddav.js:143-469`).
- **ETag / If-Match conflict handling**: updates and deletes honour `If-Match` and `If-None-Match: *`, returning 412 on precondition failure and 409 on UID/filename/unique conflicts (`caldav.js:271-294`, `carddav.js:362-397,448-459`).
- DAV writes are refused (403) for non-local or read-only calendars, and (409) for events the server owns because invitations were sent for them, so a client cannot silently break an invitation (`caldav.js:262,272`, `carddav.js:359`).
- **Sync tokens and tombstones**: CalDAV uses a monotonic `sync-<version>` token backed by a change log with deleted markers returned as 404 entries; CardDAV uses `urn:inboxora:carddav:<book>:<version>` backed by a contact change log, plus a `getctag`. An unknown or too-new token returns 409 `valid-sync-token`, forcing a full re-sync (`caldav.js:180-236`, `carddav.js:67,259-305`).
- **Resource filenames** use the stored `dav_filename` and fall back to `<uid>.ics` / `<uid>.vcf` (URL-encoded); pre-existing UID-based URIs keep working (`caldav.js:230,246`, `carddav.js:226,281`).
- CardDAV PUT stores the client's vCard verbatim and derives the index columns from it; malformed dates are rejected with 400, and DELETE with a stale `If-Match` returns 412 (`carddav.js:344-347,448-459`).
- DAV endpoints are rate-limited to 500 requests per IP per limiter window, and auth failures are logged as `caldav_auth_fail` / `carddav_auth_fail` (`caldav.js:80-96`, `carddav.js:36-56`).
- **CardDAV client (pull)**: a user can connect a remote CardDAV server (e.g. Nextcloud) with server URL, username and password; credentials are verified before storing and encrypted at rest. **[config: remote CardDAV account]** (`backend/src/routes/carddavAccount.js:41-95`)
- The client discovers address books via the given URL and the `/.well-known/carddav` fallback, syncing into read-only local books, with duplicate handling configurable as **separate / merge / skip** and a 15–1440 minute interval plus "Sync now" (`backend/src/services/carddavClient.js:127-132`, `carddavAccount.js:18,98-121`).
- Disconnecting removes the synced read-only books and contacts but not the remote data (`carddavAccount.js:123-135`).
- Public remote CardDAV servers must use HTTPS; plaintext HTTP is only accepted for private/local hosts and only when the admin allows private hosts (`carddavAccount.js:50-68`).

---

## 4. Mobile and native shells

### 4.1 Responsive layout
- Two thresholds exist: **767 px** (mobile shell; CSS `@media (max-width: 767px)` and JS `MOBILE_QUERY`) and **1100 px** (compact layout, JS only) (`frontend/src/hooks/useMobile.js:3`, `frontend/src/ui.css:37`, `frontend/src/hooks/useCompactLayout.js:8-15`).
- Below 767 px the app switches to a single-pane mobile shell with one **top bar**, a slide-in drawer, and no bottom navigation bar; the top bar hosts the active module's own header through `MobileModuleHeader` (`frontend/src/components/MailApp.jsx:788,975-992`, `MobileModuleHeader.jsx:10-18`).
- Mobile navigation can be placed **top or bottom** by user preference (`MailApp.jsx:977-980`, `frontend/src/store/index.js:539-543`).
- A **floating action button** provides the primary create action on Mail, Calendar and Contacts when navigation is at the top (`MobileFloatingAction.jsx:5-9`, `CalendarPage.jsx:253`, `ContactsPage.jsx:642`).
- The drawer closes on a left swipe of at least 60 px when the horizontal movement dominates (`MailApp.jsx:797-831`).
- Below 1100 px, Mail shows list XOR reader with a Back row; Contacts and Calendar also use the compact layout, and Calendar event dialogs become full-screen on phones (`MailApp.jsx:878-887`, `ContactsPage.jsx:79`, `CalendarPage.jsx:72,254`).
- Phone CSS raises buttons to 44 px and contacts tap targets to 40 px, stacks form columns and makes full-screen dialogs respect safe areas; safe-area insets come from `--sat`/`--sab` (bottom inset applied to the top bar, drawers, dialogs, toasts and FAB; the top bar applies no top inset) (`ui.css:37-51`, `contacts.css:27-30`, `frontend/src/index.css:6-7`).

### 4.2 System Back handling
- Dismissible UI layers register with a priority; the highest priority wins, then LIFO (`frontend/src/utils/backNavigation.js:12`).
- Registered layers include the reader (10), contacts list/detail (20/30), calendar (20), the mobile drawer (1300) and the admin panel (2000) (`MailApp.jsx:412-417`, `ContactsPage.jsx:330-332`).
- Back is consumed even while a form is busy so a save is not abandoned, and at the mailbox root normal browser/OS Back is preserved (`backNavigation.js:2,31-40`).
- On Android the hardware Back button calls the JS handler and only backgrounds the app when JS reports the event unhandled (`frontend/packages/android/.../MainActivity.java:19-24,72-91`).
- Browser `popstate` dismisses the top registered layer only when the history entry is not the armed layer (`backNavigation.js:33-40`).

### 4.3 PWA and Web Push
- `frontend/public/manifest.json` declares a standalone PWA named Inboxora with a `mailto:` protocol handler and 192/512/maskable icons; iOS standalone meta tags are present and a service worker registers on app start (`frontend/index.html:11-20`, `frontend/src/App.jsx:20-21`).
- The service worker is **push-only**: it has no fetch handler, no caching and no offline app shell (`frontend/public/sw.js:1-3`).
- It renders new-mail notifications, sets the app badge, renotifies, posts a change message to open clients, persists a pending deep link for notification clicks, and re-subscribes on `pushsubscriptionchange` (`sw.js:17-117`).
- **Web Push requires operator-provided VAPID keys**; without them push is disabled and the settings UI says so. **[config: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY]** (`backend/src/services/pushNotifications.js:5-17`, `frontend/src/hooks/usePushNotifications.js:51-53`).
- Users enable/disable push from Settings → Notifications; subscribing requests permission, subscribes with `userVisibleOnly` and posts the subscription to the server (`usePushNotifications.js:75-126`).
- An already-granted subscription is re-registered at launch, throttled to once a minute, without prompting (`frontend/src/utils/pushSubscription.js:7-21`).
- No in-app install button, offline mode or workbox/vite-plugin-pwa integration exists.

### 4.4 Electron desktop shell
- An Electron shell exists under `frontend/packages/electron/` and is the package `main`; build via `electron:dist` with nsis/dmg/deb/rpm targets and `mailto:` protocol registration (`frontend/package.json:11,33-34`).
- It runs with `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`; navigation is restricted to the configured origin and external links open in the system browser (`main.cjs:1598-1616`, `security.cjs:67-118`).
- It provides a tray icon, hide-on-close, dock/taskbar entries, an unread badge, native new-mail notifications, a context menu and `mailto:` deep links (`main.cjs:346-352,545-615,1545-1565,1826-1850`).
- Updates are checked against GitHub releases with SHA-256 digest verification and Windows publisher / macOS code-signature checks before install; Linux packages get a manual copy-and-quit command instead. There is no auto-update library. **[config: HTTPS host / update channel]**
- The first run shows a host setup page; public hosts must be HTTPS and only localhost/private ranges may use cleartext (`frontend/packages/native-shell/index.html`, `security.cjs:14-45`).

### 4.5 Android / Capacitor shell
- An Android Capacitor project exists (`frontend/packages/capacitor.config.json`, `frontend/packages/android/`); there is **no iOS project**.
- The JS bridge is inert unless `Capacitor.isNativePlatform()`; it exposes host setup, unread badge, update check/install, notification permission and native actions (`frontend/src/utils/capacitorNativeBridge.js:32-100`).
- The native plugin supports host get/save/reset, unread count, update check/install, notification permission/settings/display and pending-action get/ack (`InboxoraNativePlugin.java`).
- Native actions cover open/reply/delete/star message, compose, sync and install-update, delivered through `mailto:` and `inboxora://` intents and deduplicated by action id (`MainActivity.java`, `frontend/src/utils/nativeActionSecurity.js:5-23`).
- Privileged native actions require a trusted intent/message whose origin matches the configured host; saving a host rejects public HTTP and requires a confirmation for private cleartext, and the WebView only loads the configured origin (`nativeActionSecurity.js:1-3`, `InboxoraNativePlugin.java`).
- A WorkManager job polls unread counts in the background and is reconciled against the app's baseline. **[config: Android background sync]**
- **The native builds are not release-ready**: the publish workflow is manual-only until signing secrets are configured and deferred security items are resolved. **[beta]** (`.github/workflows/publish-apps.yml:3-5`)

---

## 5. Settings and administration

### 5.1 User settings
- **Theme**: ~24 built-in themes plus a locally stored custom theme choice; an admin-only global **custom CSS** field is applied to every user. **[admin only for CSS]** (`AdminPanel.jsx` Themes tab, `backend/src/routes/admin.js:216-226`).
- **Fonts and font size**: dozens of font sets plus a font-size slider (80–130 %); some retro sets are hidden from the picker (`AdminPanel.jsx` Fonts tab, `auth.js:802`).
- **Language**: 9 UI languages — English, German, French, Spanish, Italian, Russian, Chinese (Simplified), Polish, Czech (`AdminPanel.jsx:5616-5626`).
- **Layout**: focused / compact / comfortable / wide / vertical; interface density compact / comfortable / spacious; mobile navigation position top / bottom (`frontend/src/layouts.js`, `AdminPanel.jsx:1796`).
- **Message list**: infinite or paginated scrolling, 25/50/100/200 per page, hover quick actions, message previews, mobile avatars, Gravatar **[opt-in]** and sender favicons **[opt-in]** (`AdminPanel.jsx:1806-1858`).
- **Swipe actions** (mobile): left and right each set to Disabled, Star, Archive, Delete, Mark as Read, Reply or Reply All (`AdminPanel.jsx:2060-2090`).
- **Sync cadence**: mail 15/30/60/120 s; folder structure 15 min/30 min/1 h/never (`auth.js:935-943`).
- **Threading, compose and read**: conversation list/reader toggles, rich text or plain text, default reply vs reply-all, and mark-as-read immediate / delayed (1–10 s) / manual (`auth.js:803-806,912-913`).
- **Notifications**: notification sound (none, 11 built-ins, or a custom uploaded sound ≤ 2 MB), unread app badge, and push notification enable/disable. **[config: VAPID for push]**
- **Privacy**: block remote images with an allow-list of addresses and domains (`AdminPanel.jsx` Privacy tab).
- **Shortcuts**: 17 rebindable actions with conflict detection and per-action or full reset (`frontend/src/utils/defaultShortcuts.js:22-53`).
- **Calendar**: first day of week, work days, working hours, default invitation sender (`AdminPanel.jsx:1520-1575`).
- **Screen lock**: PIN (4–6 digits) with auto-lock off/1/5/15/30 minutes; **profile**: display name (≤ 100 chars) and avatar upload/remove (`auth.js:702-727`, `ProfileModal.jsx`).
- **Signatures** are per sending account and per alias, edited in the Accounts tab; there is no separate user-wide signature. **[config: mail account]**

### 5.2 Admin settings tabs
- The admin surface is grouped as **Account & Mail** (accounts, notifications, rules, categories, cleanup), **Calendar**, **Display** (appearance, shortcuts), **Security & Integrations** (security, DAV access, integrations, AI, AI actions, plugins), **Administration** (users, SSO) and **About** (`AdminPanel.jsx:6753-6836`).
- **Accounts**: add/edit mail accounts with provider presets, IMAP and SMTP hosts/ports/credentials, TLS-skip option, account color and sender name, enable/disable, unified-inbox inclusion, folder mappings with auto-detect, per-account signatures and aliases, folder sync and search re-index. **[config: IMAP/SMTP]** (`AdminPanel.jsx:448`)
- **Rules** with a **Block List** sub-tab: conditions on From/To/Subject/Body/Header/attachment/read status, AND/OR, contains / not contains / exact / starts with / ends with / regex, and actions mark read, star, archive, delete, move, forward, stop processing, plus apply-to-inbox (`AdminPanel.jsx:5821,6484`).
- **Categories**: global enable, Social domain sources (manual, subscribed URL, built-ins) and re-categorize existing mail; categorization is **disabled by default** **[opt-in]**; **Cleanup** offers a per-account bulk-mail summary and bulk archive/trash actions. **[beta]** (`AdminPanel.jsx:4246,6577`)
- **Calendar**: the calendar user settings listed in §5.1; **Appearance**: Theme (+ custom CSS), Layout and Language & Font sub-tabs; **Shortcuts**: rebinding UI, hidden on mobile.
- **Security**: TOTP 2FA, screen-lock PIN, recovery email, linked SSO identities, and admin-only blocks for login protection (max attempts/window), mail-server connection policy (private hosts, insecure TLS, non-standard ports), MFA enforcement with device-trust duration, and a login-activity log; a **Privacy** sub-tab holds remote-image blocking and the allow-list (`AdminPanel.jsx:7385,7078`, `admin.js:99-111`).
- **DAV access**: create/list/revoke DAV application passwords and copy DAVx5 setup details (`AdminPanel.jsx:8359`).
- **Integrations**: Microsoft 365/Outlook OAuth app configuration, CardDAV client connection and Todoist connect/disconnect; secrets are admin-only and non-admins see only a configured flag. **[config: provider credentials]** (`AdminPanel.jsx:2415`, `integrations.js:9-37`)
- **AI Assistant**: enable AI, choose API-key or ChatGPT subscription connection, set base URL/key/model, toggle compose and summarization features, and test the connection. **[admin only, config: OpenAI-compatible endpoint]**
- **AI Actions**: user-defined prompt shortcuts (label ≤ 60 chars, prompt ≤ 2000 chars, max 30); disabled when AI is off (`auth.js:811-819`).
- **Plugins**: per-user activate/deactivate list; this build ships one GTD plugin. **[beta]** (`frontend/src/plugins/gtd/`)
- **Users**: users and invites (§5.3) plus system email (§5.4). **[admin only]**
- **SSO**: enable/disable password login (blocked unless a provider is enabled and the admin has a linked identity) and full OIDC provider CRUD with provider templates, scopes, allowed domains, provisioning mode, verified-email and admin-group-claim options, and a last-provider guard. **[admin only, config: OIDC provider]**
- **About**: version, backend and frontend build SHA, AGPL-3.0 licence, source link, and a diagnostics report button.

### 5.3 User management and invitations
- Admins can list users with pagination, grant/revoke the admin role (cannot remove their own), delete a user (cannot delete themselves; stops IMAP/CardDAV workers and runs plugin cleanup), and disable another user's TOTP (`admin.js:22-88`).
- There is no admin "create user and set password" route; accounts come from open registration or invitations (`admin.js` user routes).
- Invitations are email-bound, single-use, expire after 7 days and return a `${APP_URL}/register?invite=<token>` link; the link requires `APP_URL` to be set. **[config: APP_URL / system email]** (`admin.js:251-271`)
- The Users tab lists pending, used and expired invitations with copy-link and revoke actions (`AdminPanel.jsx:4748-5150`).
- Password reset is self-service via a one-time e-mailed link to the account's recovery email (needs system email); no authenticated change-password endpoint exists (`auth.js:1028,1150`). **[config: system email]**
- 2FA is TOTP with QR enrolment and an e-mail OTP fallback to the recovery address; MFA can be enforced server-wide (`auth.js:436-588`, `admin.js:194-215`).
- SSO identities can be linked and unlinked per user (`AdminPanel.jsx` LinkedIdentitiesSection).

### 5.4 System email
- The SMTP relay for system mail stores host, port, encryption (STARTTLS / SSL-TLS / none), username, password, From name and From address; the password is stored encrypted and masked when read back (`admin.js:390-446`). **[config: SMTP relay]**
- A test action verifies the transport, and the configuration can be deleted (`admin.js:448-484`).
- System email is used for invitations, password resets and e-mail OTP; when unset, invite mail falls back to the admin's first SMTP-enabled personal account (`admin.js:280-337`).

### 5.5 Diagnostics and update check
- A **diagnostics report** can be generated, copied or downloaded as JSON; it includes versions, environment, per-account and folder counts, sync error categories and server health, and excludes addresses, names, content and secrets, hashing identifiers (`backend/src/routes/diagnostics.js`, `frontend/src/components/DiagnosticsReportModal.jsx`).
- A server-side **update check** queries GitHub releases with a 6-hour cache and 15-minute failure backoff, and can be disabled with `UPDATE_CHECK_DISABLED=true`; the browser never contacts GitHub. **[config: UPDATE_CHECK_DISABLED]** (`backend/src/services/updateCheck.js:14-16,46-65`)
- **No backup/restore feature was found** in the routes or the admin UI.

## 6. Not verified / uncertain

- No runtime verification was performed (the app and test suite were not run); all statements come from source reading.
- No UI was found for creating `RRULE`/`RDATE` rules; recurrence appears supported for imported/DAV events and single-occurrence editing only.
- The stored `timezone` is written from the browser and used when projecting, but whether a user can pick a different event time zone in the UI was not confirmed.
- Contact photo upload/replace in the browser was not confirmed; the reading path (`PHOTO` parsing, `/api/contacts/photo`) is verified.
- The exact membership of the ~24 themes and ~34 font sets came from their tables, not from rendering.
- Admin Accounts/Integrations details (Microsoft device-code flow, Todoist) and Electron/Android internals were summarised from the delegated reports, not read line by line by this file's author.
- Whether `PATCH /api/auth/preferences` accepts `calendarInviteAccountId` was not confirmed; the store writes it and reads it back, but the backend destructuring list I read did not include it.
- No iOS shell exists; whether one is planned could not be determined from the code.
