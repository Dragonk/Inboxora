# Inboxora: navigation, live mail and installation identity

The update follows `V3-Inboxora.html` and the mobile feedback. Calendar and Contacts share the mobile shell header with Mail. The menu remains reachable, while module actions create an event/contact or open the calendar/address-book selector. Full contact fields, multiple books (including all visible books), multiple calendars, imports, source management and event dialogs remain available.

Calendar preferences have a separate settings tab. Week start, working days and working hours retain their existing preference keys and validation. Global mobile navigation position belongs to Appearance → Layout and moves the common menu/actions for every module. Choice controls use the existing theme tokens and accessible selection states.

System folder names are localized in navigation, favorites, headings, search and move selectors using server roles and explicit account mappings. API paths remain unchanged. Custom folder names and explicit favorite labels are retained. The nine shipped languages have matching keys. Layout names, descriptions, compact mail dates and time units also follow the selected language; date formatters are reused across rows.

## Measurements

Same local Ubuntu VM, PostgreSQL 16, synthetic data only. Baseline: dev `8e418b9`. Each database case excludes one warm-up and reports the median of five samples. The fixture has three accounts, 30,000 messages each, repeated thread keys across accounts, Inbox/Sent membership and mixed read flags.

| Operation | Before | After |
| --- | ---: | ---: |
| Unified threaded list, 50 rows, 90,000 messages | 2709.7 ms | 95.5 ms |
| One account, threaded list | 42.6 ms | 31.8 ms |
| Unified flat list | 3.5 ms | 4.0 ms |

The backend now joins on typed `account_id` and `thread_key` rather than concatenating text in join predicates. Counting uses the same account/thread grouping. Unified presentation IDs still include account identity; authorization and physical-copy normalization are unchanged.

Browser measurements use a production build and a deliberately delayed (600 ms) list API. Calendar → unified inbox previously took 857–896 ms on desktop and fetched the list again. The new path reused the live mounted list: initial isolated runs were 48–59 ms on desktop and 45–53 ms at 390×844, with zero list requests and the expanded thread retained. Timing is measured from DOM click to two animation frames after content appears. These are local regression measurements, not production-network guarantees. Browser tests enforce <300 ms on this warm return.

Run `NODE_ENV=test DB_* node src/scripts/benchmarkMessageList.js` against an isolated database to repeat the database measurement. The script creates a unique synthetic user and removes its own data in `finally`.

## Live state

Returning from a module retains current store state instead of restoring a historical snapshot. WebSocket updates continue while Calendar is visible. Individual read updates include the physical representative of a thread; the aggregate becomes read only when no unread children remain. Explicit whole-thread actions retain their supplied aggregate and existing rollback behavior.

Server events refresh the expanded thread's membership without removing visible children while loading. Responses are rejected after account/folder changes or newer thread mutations. The open reader also refreshes native membership while preserving expansion and the existing body iframe. Its background responses are rejected after navigation or local read mutations, and pending read/delete intents are protected. Collapsed caches are invalidated and reload on demand. Remote flags also reconcile aggregate rows which may contain copies absent from the local cache. An event received during the initial list request schedules a catch-up refresh when that request finishes.

## Brand assets

`frontend/src/brandMark.js` is the vector master for the new envelope symbol. Runtime chrome and the themed favicon use the same geometry. `frontend/scripts/generate-brand-assets.mjs` exports PNG assets with Chromium; Electron preparation consumes the generated size variants. Android adaptive foregrounds use the same symbol.

The PWA manifest references new asset filenames: 192 and 512 px regular icons plus a 512 px maskable icon with an inset symbol. Apple touch icon is 180 px; push uses a separate monochrome badge. Manifest and service worker URLs are versioned; nginx revalidates manifest metadata. Existing service-worker push/click behavior remains intact.

## Validation

- Frontend: 2,076 unit checks and lint passed. Backend: 1,540 unit checks, lint and 10 PostgreSQL regression cases passed.
- Full browser pass: 272 passed / 198 viewport skips, including both list/reader feature switches, mutation ordering, rollback, mobile touch navigation and 45 visual reference images. The additional Chinese-locale scenario passed separately; final navigation, live-reader and latency checks also passed.
- Real API: all nine scenarios passed. During a later parallel stress run the first desktop scenario exceeded the 30-second total timeout; the other eight passed, and the timed-out scenario passed alone in 6.7 seconds. No timeout increase was made.
- Visual review included the compact mobile calendar, contact detail, separate Calendar settings, global navigation choices and login with the new symbol.
