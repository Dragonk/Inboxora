# Implementation status against the v4 plan (P00–P14)

This is the honest per-package status of the v4 delivery (`Inboxora-plan-wdrozenia-v4.md`) on the
integration branch `dev`. It records what is **verified and integrated**, what is partial, and what
has not been started, with the commit that delivered each piece so the claims can be checked with
`git show <sha>`.

Nothing here is aspirational: a package is only marked delivered when its behaviour is covered by
tests — including integration tests against a real PostgreSQL where persistence, leases or cursors
are involved — and merged to `origin/dev`.

Last verified on `dev` at `953ba4be`: backend typecheck, lint and **2233 tests**; frontend
typecheck, lint, production build and **2644 tests**. `main` has not been touched by this work.

## Status

| Package | Status | Delivered (commit) | Missing |
| --- | --- | --- | --- |
| P00 — preparation/audit, **CI repair** | **partial** | — | The baseline was produced and `ci.yml` runs `typecheck`, `build`, `lint` and the unit tests on every push, which satisfies the plan's "correct typecheck/build in CI". What is **not** repaired is coverage: the database integration suites and the browser matrix — the two layers that found this work's real defects — are not gated and run only by hand. Ready-to-apply recipes for both are recorded above. |
| P01 — shared provider contracts | **partial** | `abbe2b9b` | The contracts and the registry are wired (the registry is read by the mail paths). `providers/capabilities.ts` is imported only by its own tests, so the capability table is not yet consulted in production. |
| P02 — additive schema (connections, grants, remote links, operation journal, outbox, notice preferences), **backfill of existing sources** | **partial** | `abbe2b9b` (connections/grants/remote links, `0101`), `78b8c182` (journal/outbox, `0103`–`0105`) | The schema is delivered, additive, and preserves existing IDs — the migrations add columns and tables and rewrite none. What is **not** delivered is the second half of the package's scope: existing sources are **not backfilled** into the new tables. Verified by reading rather than assumed: no migration anywhere inserts into `integration_collections`, `provider_connections` or `remote_object_links`, so today's ICS subscriptions, CardDAV accounts and IMAP accounts remain described only by their own older tables. Nothing is broken by that — they keep working through their existing paths — but the provider layer does not yet *know* about them, which is what P10 and P11 will need. |
| P03 — operation journal, sync leases, domain outbox, **common ingest and mutation services** | **partial** | `78b8c182` | Three of the package's four parts are accounted for: the **leases** are wired, since the Google and Microsoft connectors take them on every run; the **operation journal and domain outbox** are delivered and tested (16 cases) but nothing in production calls them — they are the intended vehicle for P10 write-back and the P12 cutover; and the **ingest** half of common services exists implicitly, as each adapter writes through its own upsert and the shared `syncCoordinator` rather than a common ingest service. What does **not** exist is a common **mutation** service: there is no shared create/update/delete abstraction anywhere, which is consistent with the write path being refused rather than forwarded (P09's CRUD, P10's write-back). A reader should not take "operation journal" as evidence that mutations are modelled. |
| P04 — OAuth flows and token service | mostly delivered | `ee788ca8` (Google web flow), `d4592756` (single-flight refresh + CAS), `524a5f00` (Microsoft refresh), `c30d13ba` (Microsoft Graph provider flow), `d4927e09` (Google flow in the UI), per-feature Google connect buttons; this session: `940d629a` (refresh re-reads the grant under the lease), `7dd0572d` + `3ed99007` (disconnect a connection, from the card), `bf9f340f` (the provider and per-method switches are enforced, not just reported) | Provider **device-code** authorization (the mailbox device flow exists; the Graph provider flow is browser-only). |
| P05 — mobile drawer gesture | delivered | `f76e1a40`, regression fixed in `143eca15` | Reachability verified and test-pinned: the pref defaults on, has a switch, persists through the server allow-list, and the hook's content/drawer/backdrop refs are attached to real elements, so the listeners cannot be attached to nothing. |
| P06 — send/draft ledger, attachment and MIME limits | **not started** | — | Durable upload/send ledger, separated file/total/MIME/HTTP limits, draft preservation on failure. See the note below on what is already enforced. |
| P07 — native Microsoft Graph adapters | **partial** | `524a5f00`, `c30d13ba`, `a9a3f975` (contacts), `d545ff45`, `c08fb7ae`, `f4d4fac1` | **Graph mail adapter** (blocks P12), Graph calendar adapter, provider device flow. |
| P08 — Gmail API mail adapter | **not started** | — | Labels/folders, message and thread ingest, attachments. |
| P09 — Google Calendar/People + MS Graph calendar/contacts | **partial** | `29bf023e` (People), `71558193` + `c8ea8383` (Calendar with generated VTIMEZONE), `d4927e09` + `8aff1d1e` (UI), `a2973f94` (schedule); Microsoft contacts under P07 | The package's scope is discovery/**CRUD** with UI switches, and only the read half is delivered: the adapters issue nothing but GETs — verified by reading, no `POST`/`PATCH`/`DELETE` in `googlePeople.ts`, `googleCalendar.ts` or `graphContacts.ts` — and REST and DAV refuse writes to a source-owned collection, so create, update and delete at the provider do not exist. **Microsoft calendars** are not imported either. What is delivered: discovery with per-collection switches, read-only pulls for Google People, Google Calendar (VTIMEZONE included) and Microsoft contacts, and the refresh schedule. |
| P10 — external CalDAV/CardDAV read-write, ICS/VCF/CSV import | **partial** | `6cf1a4bf` (vCard import), `6cccd470` (iCalendar import); Google CSV import pre-existed | External CalDAV/CardDAV **write-back** client. |
| P11 — DAV server hardening | mostly delivered | `0afab53d` (discovery/classes), `58f2c809` (strong `If-Match`), `d7b8ceb9` (per-collection visibility/mode), `1a84536d` (per-password ceiling), `db97a1af` (WebDAV `If` header), `6c6584cb` + `811a50d8` (connector status visibility) | Any remaining `DAV:` classes the plan lists. (Write refusals now carry a `DAV:error` body naming the reason, so a client can tell a read-only collection from a permissions failure.) |
| P12 — account migration/cutover, MS-required and Google-recommended notices | **not started** | `acd1bf78` + `35451f02` cover the notices | The **notices** exist: the Microsoft card states that Outlook.com and Microsoft 365 no longer accept a mailbox password, and Google's recommendation is stated in that provider's own description. The **migration/cutover** is not started and stays deliberately blocked: a migration flow must not point users at a mail transport that does not exist yet (needs P07b/P08). |
| P13 — hardening, E2E, release notes | **partial** | `065b3f86` (provider setup procedure), `6cccd470` + `6cf1a4bf` (imports), the DAV work under P11, the browser gate and the acceptance reports above; i18n kept at nine locales | Delivered: the end-to-end suite for the touched flows — **including the connector card, which had no browser coverage until this work gave it one** — the wiki pages, current UI copy, the unsupported-operations list and the W-list/matrix reports. Open: **release notes for a chosen version** (needs the version decision), the real-client DAV run, and the **installation-wide switch**, which now exists: `PROVIDER_INTEGRATIONS_ENABLED=0` makes an installation offer and accept nothing from the provider layer, read by the four authorization flows and by the readiness report from one place, with unset meaning enabled. The per-provider and per-method switches still say which parts a configured installation offers. |
| P14 — final integration, CI, publish images | **not started** | — | Publish both `:dev` images **for both architectures** and smoke-test the pair, from one SHA, with the acceptance report. Needs a release version and registry authorization. |

## Verification performed on a fresh database

The whole chain was re-applied **from zero** on an empty PostgreSQL 16 and every gated integration
suite was then run against that database, so the provider stack is proven on a schema a new
installation would actually have rather than on one evolved in place:

- all 109 migrations apply in order with no error, and the provider tables
  (`provider_connections`, `oauth_grants`, `integration_collections`, `remote_object_links`,
  `provider_operations`, `domain_outbox`, `sync_states`, `account_notice_preferences`) all exist
  afterwards;
- **P11's acceptance criterion in the plan is a full loop with DAVx⁵**, and that has *not* been
  performed. What is verified is the protocol: discovery, policies, the change log, the preconditions
  and the write paths are exercised by unit, database and browser-level tests, and the requests they
  send are the ones a client sends. Nothing here has talked to an actual DAVx⁵, Thunderbird or
  macOS client, so client-specific behaviour — its exact `PROPFIND` bodies, its retry and error
  handling, its reaction to a refused `PROPPATCH` — is untested. That is the honest boundary of the
  DAV work, and it is the one acceptance criterion in P11 that remains open.
- 89 integration tests pass across eleven suites: the provider authorization-flow table, Google and
  Microsoft token refresh (including the two-worker race), the operation journal and outbox, the
  Google and Microsoft contact syncs, the Google calendar sync, the provider disconnect and its reconnect cycle, and the DAV HTTP
  integration. The
  contact suites also assert the `sync_states` bookkeeping the connector status line reads: a success
  must leave a success time and clear the error, and a failure after the lease is taken must record
  both the code and the time, so that data source is regression-protected rather than verified once
  by reading the code.

## Documentation verification

The plan requires the documentation to match the built code (DO07), so the wiki was checked
mechanically rather than by reading: every API/OAuth path, DAV endpoint and environment-style
identifier quoted across `docs/wiki/*.md` was grepped against the sources.

Result: no documentation errors. Of 7 distinct paths and 46 identifiers, the five that the first
pass could not find in `backend/src` or `frontend/src` are all legitimate references to something
outside the application's own code — `SHCNF_FLUSH` is an Electron shell flag used by
`frontend/packages/electron/`, `POSTGRES_DB` and `INBOXORA_VERSION` are variables of the operator's
own container environment named in install and upgrade commands, `MAILFLOW_VERSION` refers to the
previous product's images in the migration guide, and `AADSTS50011` is a Microsoft-side error code
that by definition appears in their response, not in our code. They are recorded here so the next
reader does not re-open the same question.

## API contract check

The endpoints added in this work were re-checked against the fields the frontend actually reads,
field by field, rather than assumed: the connector status payloads
(`configured`/`connected` plus `books[]` or `calendars[]` and their per-row fields), the
per-connection sync results, the import payloads, and the route error shape, which `api.ts` turns
into the thrown message the UI displays.

The check is recorded because it is cheap and it found a real defect at the time — the calendar
status endpoint was missing `lastErrorAt`, so the dialog rendered an empty `… ( )`.

**What it covered then is not what those payloads are now**, so the scope is restated rather than
left implied:

- the import payloads gained a **`protected` count** with the invitation guard, and the card renders
  it;
- `connections` is no longer a count but the **array of the caller's own connections**, added for the
  disconnect control, and that control uses each entry's `id`;
- the status payloads gained **`graph`** (the connector's own readiness), **`mailPolicy`** and
  **`traditionalImapAvailableInInboxora`**, each of which the card reads;
- the disconnect endpoint answers **`{ connectionId, collectionsDisabled }`**, which the card
  discards by design — it refreshes the status instead;
- the DAV refusals and the request-too-large answer are **XML and `413` bodies**, not JSON, and are
  asserted where they live (P11) rather than here.

Each of those was checked as it was added, which is why the list is longer than the check; re-running
the whole set after touching any of these endpoints is still the right habit.

## DAV visibility of imported data (verified, not assumed)

Whether data written by the connectors and the importers reaches DAV clients depends on
database triggers rather than on the routes, so it was verified directly against PostgreSQL
16 with the full migration chain rather than inferred from the code:

- **Calendars:** inserting a `calendar_events` row advances `calendars.sync_version` and sets
  `sync_token` to `sync-<version>`, which is the value the CalDAV endpoint advertises. The
  `.ics` import therefore no longer writes a token of its own — a random UUID it used to
  write replaced a well-formed one.
- **Contacts:** inserting a `contacts` row advances `address_books.sync_version`, from which
  the advertised CardDAV token `urn:inboxora:carddav:<book>:<version>` is derived. The
  importer's `bumpSyncToken` refreshes the `getctag` that older clients poll and is *not* what
  notifies collection-sync clients; that is now documented at the helper so it is neither
  relied on nor removed by mistake.

## What running the end-to-end suite found, and what happened to it

The Playwright suite was not among the gates run while this work was built, and running it found two
things the unit and contract tests could not. Both are now resolved, and the suite has been run
repeatedly since (see the matrix below), so nothing here is outstanding:

1. **Fixed:** `contacts-address-books.spec.ts` asserted that renaming an address book sends
   `{ name }` only. The rename dialog deliberately sends the book's DAV access as well, so the
   assertion had been stale since that dialog learned to edit both. The expectation now includes
   `davMode` and the spec passes.
2. **Fixed:** three mobile-navigation tests in `calendar.spec.ts` failed because the drawer
   stayed fully on screen after a module navigation and intercepted the next click. Root cause
   was in the drawer gesture hook: after animating, it handed styling back to React by *clearing*
   the inline transform. React does not re-apply a style it has already committed, so the drawer
   was left with no transform at all — rendering at its layout position, fully open — while the
   state said closed. A navigation click also fires `blur`, which aborts the gesture sequence and
   triggers exactly that path. It now restores the value React owns for the current state.
   Verified: the three tests pass, the full `chromium-desktop` project is green (123 passed, 59
   skipped), and the drawer-related specs pass on `chromium-mobile-390`.

Run the suite with:
`PLAYWRIGHT_BROWSERS_PATH=$PWD/../.pw-browsers npx playwright test --project=chromium-desktop`

## The plan's execution matrix (`Macierz-testow-do-uzupelnienia.md`)

The delivery archive carries a second gate artifact beside W01–W19: an execution matrix of numbered
scenarios across **AU** (authorization), **ML** (mail), **AT** (attachments), **KC** (contacts and
calendars) and more, with columns ID / scenario / level / state / SHA-evidence. In the archive **every
row still reads `NIEURUCHOMIONY`** (not started).

It is not reproduced here, because copying it would create a second copy to drift. What belongs here is
which rows this work can already evidence, so the next session fills the matrix in the plan's own file
rather than reconstructing it:

| Row | Scenario | Evidence in this repository |
| --- | --- | --- |
| AU07 | Two workers refresh the same grant in parallel; no new refresh token is lost | `providerTokenService.integration.test.ts`, the race case — and the double-exchange window it exposed, fixed in `940d629a` |
| AU11 | The same identity with a changed address or alias does not duplicate the account | `upsertProviderConnection` keys on user + provider + issuer + subject; the reconnect case in `providerConnectionService.integration.test.ts` asserts one row survives a disconnect and re-authorization |
| KC03 | Series with exceptions, a cancelled instance and a moved exception stay consistent | The Google calendar merge (`71558193`) with `c8ea8383`; the merge case "a moved instance and a cancelled event" passes in the provider suites |

More rows this work can evidence, all from tests observed passing in this session:

| Row | Scenario | Evidence in this repository |
| --- | --- | --- |
| DV03 | The intersection of DAV off / credential read-only / collection read-write, on every endpoint | `davCredentials.test.ts` for the per-password ceiling and `davVisibility.test.ts` for the per-collection mode; the write refusals are asserted per protocol |
| DV08 | Bad or weak `If-Match`, `If-None-Match: *`, two parallel `PUT` | **PASS.** `davPreconditions.test.ts` covers weak and tagged-list conditions (failing closed), and `davPg.integration.test.ts` runs two parallel `PUT`s with the same `If-Match` against a real database and asserts the statuses are exactly `[204, 412]` — one wins, one is refused, no lost update |
| DV16 | Importing an ICS file versus an invitation arriving by mail: separate processes, correct UID collision | `calendarIcsImport.test.ts`, which asserts that a file does **not** overwrite an event Inboxora owns through a sent invitation and reports it instead |
| DV19 | WebDAV `If` with a token and a collection Resource-Tag: compliant evaluation, no ignoring, no cross-user bypass | `davIfHeader.test.ts` with the `evaluateDavIf` decision table, tagged lists failing closed |
| GE06 | The gesture switch turned off, then a reload and a new sign-in: it stays off and the zone returns to the row | `f76e1a40` with the preference allow-list; the switch, its default and its persistence are pinned by a contract test |
| MG01 | A Google app password stays active without OAuth; Microsoft legacy needs Graph consent; a password is never converted into a token | The authorization requests read-only People/Calendar scopes, no mail transport changes, and no code path turns a password into a grant |
| MG04 | Standalone Google/Microsoft DAV, ICS and plain IMAP accounts: no migration is forced on them | Nothing in this work migrates or deletes another account's configuration; the only removal path is an explicit owner-scoped disconnect |

| DV07 | UID different from the filename: read, PUT, DELETE and sync use a stable href | **PASS.** `davPg.integration.test.ts` stores an event whose `UID` is `embedded-event` under the file `client-generated.ics`, and a contact whose `UID` is `embedded-contact` under `client-generated.vcf`, then asserts the stored `dav_filename` and the sync-change row — so the href, not the UID, is the identity |
| DV06 | DTD/XXE, large body, deep XML, traversal and cross-origin hrefs are safely rejected | **XXE: not applicable, verified by reading. Rest: NOT RUN.** The CalDAV and CardDAV routes never build a document from a request body — they use `String.includes` and regexes for the elements they need (`sync-token`, `href`, `time-range`), so no parser expands an entity and a DTD is inert text. There is **no test** for it, and the large-body, deep-XML and traversal parts remain unverified; the body-size limit the DAV routes run under was not checked |
| DV05 | Different XML prefixes and requested properties, entities and CRLF behave correctly | **PARTIAL, by construction.** The element regexes accept an optional namespace prefix — `(?:[A-Za-z][\w.-]*:)?` on `sync-token`, `href` and `time-range` — which is what the row asks for, and `decodeDavCharRefs` handles numeric character references on the response side. Verified by reading, **not** by test, and CRLF handling was not checked |

**One correction worth stating:** DV08 was recorded as NOT RUN for its parallel-`PUT` half in the
previous revision. That was wrong — I read the unit-level precondition file and did not open the
integration suite, which has covered it on a real database all along. It is the third time in this
work that I described coverage from the wrong source rather than reading the one that holds it.

**And a fourth, caught before it could stand:** the previous revision of this table recorded DV06 as
PARTIAL, "the XXE/DOCTYPE theme is exercised in three suites". That was false. Those three files
matched the *`dav_mode = 'off'`* pattern in a shell call that ran several greps, and I attributed the
output to the wrong one; the XML hardening of DV06 has no test at all and is NOT RUN. The row is
corrected, and the mechanism is worth naming because it is a new layer of the same habit — this time
the misreading was of my own tool output, not of the code.

**The remaining KC rows need reading, not guessing.** I searched for their themes and am recording
where to look, deliberately **without** a verdict — the DV06 entry above is the cautionary tale, where a
filename match was written up as coverage and had to be taken back:

| Row | Where to look | State |
| --- | --- | --- |
| KC04 (DST, differing TZIDs, date-only, exclusive end, midnight) | `googleCalendar.test.ts` asserts a DST zone is emitted from the platform tz database (`TZID:Europe/Warsaw`), **a decade of transitions** so a later DST boundary is defined, a date-only event as `VALUE=DATE` with its **exclusive end**, and `TZID` conversion on `DTSTART`/`RECURRENCE-ID` | **PASS**, including the midnight case that no assertion had covered: a case projects local midnight (`20260901T000000` in `Europe/Warsaw`) to `2026-08-31T22:00:00Z` — the previous day in UTC — and another writes a midnight instant back as `20260901T000000`, asserting that no `20260831T` appears. That is the day-shift hazard the row exists for, now pinned in both directions |
| KC13 (vCard 3/4, many fields, a date without a year, a photo, Polish characters) | `utils/vcard.test.ts` round-trips `ANNIVERSARY`, rejects and labels an impossible date (`2021-02-29`), and preserves unknown properties (`X-CUSTOM`). The three gaps found by reading it are now closed by cases of their own: a **`VERSION:4.0` card** parses like 3.0 with non-ASCII text intact, a 4.0 birthday without a year (`--1210`) yields `null` rather than an invented date, and `PHOTO` is carried as a **data URI** for inline images while a `VALUE=URI` reference is not stored as if it were the image | **PASS** for the asserted parts. The suite's fixtures were ASCII before these cases; a format the parser ignored would have gone unnoticed behind a green suite, which is why they were worth adding |
| KC15 (one Google contact in several groups: no duplicate canonical contact) | nothing matched | **no duplication, verified by reading; memberships are dropped.** The sync upserts one row per `resourceName`, so a contact in several groups cannot duplicate — but `memberships` appears nowhere in the Google provider code, so the groups are discarded rather than stored. That is now stated in the wiki as a limitation. Carrying them would mean resolving `contactGroups.list` to names and writing them as `categories`, which the contacts table already holds. Reading the mapper for the same question found more: it used names, emails, phones, organisation, title, addresses, nicknames, notes, URLs and birthdays, and dropped photos, anniversaries and instant-message handles. **Anniversaries and handles are now carried** (the mask asks for `events` and `imClients`, both mapped and tested); **photos and memberships still are not** — a photo needs an authenticated request per contact, and group names would need a `contactGroups.list` call |

**GE12 and the device halves of GE01–GE05 and GE09 are NOT RUN**: they require Android/PWA and Safari
iOS, and no device was used.

Everything else on the matrix is **NOT RUN**, and for large parts of it that is structural rather than
an oversight: **ML\*** needs the mail adapters that do not exist (P07b, P08), **AT\*** needs P06, and
**AU01–AU03, AU05, AU06, AU09, AU10** concern the migration and consent flows of P12. The **KC** and
DAV rows are covered at protocol level but share P11's open criterion: no real client was driven.

Recording this way is deliberate: the plan requires PASS, FAIL, SKIPPED and NOT RUN separated with
evidence, and a row is not PASS because a similar test exists.

## Closed: the DAV request body is bounded

The CalDAV and CardDAV routes read their own request bodies, and nothing capped them: the
application's `express.json({ limit: '1mb' })` does not apply to XML, calendar and vCard content
types, so a client with a device password could stream an arbitrary body and have the process hold it
in memory on the endpoints that serve everyone else. The body is now capped at **1 MB** inside
`rawBody`, where the request is legitimately read; excess is discarded rather than buffered, and the
rejection carries body-parser's `entity.too.large` marker so the application answers `413` with the
route-aware message it already gives for oversized JSON uploads. Both protocols are covered and the
refusal writes nothing.

**Three attempts were needed, and the reason is worth keeping.** The first added the cap as
router-level middleware that watched the stream, which broke 30 tests: attaching a `data` listener
there starts the request flowing before the handler runs, so every body arrived empty. The second and
third moved the cap into `rawBody` — correctly — and then hung in the test, which produced two wrong
conclusions in this document, including "the cap may already be correct". A probe with no cap in the
code showed a 1.1 MB `PUT` answering `400` promptly, which cleared the read path and pointed at the
rejection path; the cause was that the **test harness did not import `express-async-errors`**, so a
rejected handler produced no response at all. The application has had that import all along, so the
production behaviour was never in question — only my ability to observe it.

The lesson is narrower than "test more": when a handler rejects and the client sees nothing, the
question is whether the rejection is *forwarded*, not what the handler did.

## Other unbounded body readers, found by sweeping for the DAV defect's shape

The DAV fix closed one instance of a general shape: code that accumulates a stream into memory with no
cap. Sweeping the backend for `on('data')` found two more, and they belong to different owners:

- **`draft.ts:143` and `send.ts:712`** read an IMAP message stream into memory with no cap. A message
  with a large attachment is buffered whole. This is **P06's territory** — the package is defined as the
  durable send ledger with separated file, total, MIME and HTTP limits — so it is recorded as part of
  that package rather than as a new defect.
- **`oidc.ts:100`** accumulated a *response* from the identity provider with no cap. **Now fixed**: the
  response is capped at 1 MB and a larger one is refused rather than buffered. **Tested directly**:
  `makeInsecureFetch` is exported so a local server can answer with 2 MB, and the case asserts the
  refusal; a second case asserts a normal response is returned unchanged. The earlier version of this
  note said the branch was true only by construction — it no longer is.

What is *not* affected: the import routes (JSON, already under the 1 MB parser limit), the DAV routes
(capped), and the request-side readers in the mail ingestion path, which stream to disk.

## Contact-field additions: verified to reach the database, with one step left

The anniversaries and instant-message handles added to both providers are mapped, and **the plumbing
consumes them**: reading each adapter's upsert shows `anniversary` and `instant_messages` in the column
list and `parsed.anniversary` / `parsed.instantMessages` among the parameters, for Google and for Graph.
So neither change is inert, which was worth checking — a mapper that returns a field no statement writes
is the same silence as a switch nothing reads.

**Google now has that assertion**: the contacts integration suite syncs a person carrying a birthday, a
dated `anniversary` event preceded by an `other` event, and an IM client without a username, then reads
the stored row — `1815-12-10`, `1835-07-08` and one `jabber` handle. Writing it also confirmed the columns
are `DATE`: the first run compared against pg's `Date` objects and failed, which was the assertion being
wrong rather than the data, so the query casts to text.

**Graph now has it too**: the Graph contacts integration suite stores a contact carrying a birthday, an
anniversary and two IM addresses (one empty) and asserts the row — `1815-12-10`, `1835-07-08` and a single
`other`-typed handle. Both providers are therefore proven end to end on a real database, not only mapped.

## Acceptance criteria W01–W19, as the plan requires them reported

The plan states that the scope is not complete until every W item has associated code **and real test
results**, that missing test accounts or devices are **not** proof of operation, and that the report
must separate **PASS, FAIL, SKIPPED and NOT RUN** and must not call the implementation fully accepted.
That is what this table is; "code ✓" never means PASS on its own.

| W | Requirement (abbreviated) | Verdict | Evidence and what is missing |
| --- | --- | --- | --- |
| W01 | Menu follows the finger; the gesture starts in the left quarter | **PASS with NOT RUN** | Gesture machine, arbiter and hook are implemented and unit-tested; **no real touch device was used**, so device behaviour is NOT RUN. |
| W02 | Gesture switch beside the mobile panel setting, persisted | **PASS** | Switch rendered next to the navigation-position setting, value persistent through the server allow-list; pinned by a contract test. |
| W03 | Scroll, row action, long-press, calendar and menu do not run competing operations | **PASS with NOT RUN** | The arbitration layer and its guard tests cover this; **not exercised on a device**. |
| W04 | External calendars/books work in the UI and over DAV as RO/RW per real rights; **the write reaches the source** | **FAIL** on the second half, **delivered on the first** | The row has two clauses and the verdict hides one of them. Imported collections *do* work in the interface and over DAV, and they are reported as read-only precisely because their source is the only writer — so "RO/RW per real rights" is satisfied, with the RW case reachable for local collections and refused for imported ones. What fails is the clause the row emphasises: a write does not **reach the source**, because write-back is the open P10 client. A reader taking the bare FAIL would conclude imported collections do not work at all, which is not the case. |
| W05 | DAV sharing independent of UI use; off / RO / RW limited by the source's rights | **PASS** | Per-collection `dav_mode`, per-password ceiling, provider collections refused writes; covered by `davVisibility` and the DAV database suite. |
| W06 | Microsoft: full mail over Graph plus that account's calendars and contacts | **FAIL** | Contacts are delivered; **Graph mail and the Graph calendar adapter are not implemented** (P07b, P07d). |
| W07 | Google: Gmail/Calendar/People recommended, free choice of transport, one transport after cutover | **FAIL** | Calendar and People are delivered; **Gmail is not implemented and no cutover exists** (P08, P12). |
| W08 | Independent calendar and contact switches per Microsoft/Google account, with collection discovery | **PASS** | Per-provider connect buttons, discovery on sync, per-collection enable/disable; the switch enforcement is tested. |
| W09 | Do not remove configuration or force migration of other IMAP/SMTP, DAV or ICS accounts | **PASS** | Nothing migrates or deletes on its own; the only deletion path is an explicit, owner-scoped disconnect that keeps imported data. |
| W10 | Keep the account and its links; Microsoft migrates automatically with sufficient consent, Google only on explicit choice | **FAIL** | No migration exists at all (P12 not started). |
| W11 | Microsoft: required notice per entry, not permanently hidden. Google: voluntary recommendation until migration or "don't show again"; always an "Ignore" | **PARTIAL** | The **Microsoft half is met**: the requirement appears on the card whenever it is opened and there is deliberately no dismissal for it, which is what "per entry, without permanent hiding" asks for — a dismiss control would have been the failure mode the row names. Google's half belongs to the migration prompt: a "don't show again" and an "Ignore" presuppose a migration to offer, and P12 is blocked on P07b/P08. Earlier this row read SKIPPED, which understated the Microsoft half and implied nothing had been done. |
| W12 | Large attachments, whole-message limit, MIME errors, forbidden files and interrupted sends explicitly handled | **FAIL**, with part of it already true | P06 has not been started, and the row's whole-message limit, MIME dimension and interrupted-send handling are what it is for. Two pieces do exist and are worth naming so the package is not read as untouched: an oversized request is refused with a route-aware message (`requestTooLargeMessage`, and the DAV body cap for those routes), and the attachment size ceiling the interface enforces is the one the parser's 35 MB limit is sized around. The send/draft ledger, the separated MIME/total limits and the interrupted-send state are the missing part. |
| W13 | Keep threads, rules, plugins, notifications, search, aliases and invitations, or name the unsupported provider operation | **PASS** | Nothing is removed by this work, and the unsupported operations are now named per provider in the wiki — no write-back, no push notifications, no remote collection creation or sharing, personal Google contacts only, no Gmail or Graph mail connection, separate Microsoft authorizations. |
| W14 | Integration to `dev`, push, tests, **both `:dev` images from one SHA** | **PARTIAL / NOT RUN** | `dev` is pushed and tested (see the counts above); **both images have not been built or smoke-tested** — that needs registry authorization. |
| W15 | No leakage between users, grants, accounts and DAV passwords; no silent data loss | **PASS** | Owner-scoped queries and 403 guards on every provider route; DAV credentials isolate users; refusals write nothing; integration tests assert the isolation. No independent audit was performed. |
| W16 | The "email providers" screen: instructions, configuration and per-method diagnostics | **PASS** | The integrations card states each provider's requirement and readiness, with the Graph/device/browser methods separated. |
| W17 | Microsoft web and device code have correct separate requirements and refresh; no Google device flow for mail/calendar/contacts | **PASS** | Separate readiness and switches, enforced in the flows; Google reports `deviceCode.supported: false`. |
| W18 | Google IMAP works without an OAuth project; attaching Calendar/People does not migrate mail or request Gmail scopes | **PASS** | The authorization requests read-only People/Calendar scopes only; no Gmail scope, no transport change, and IMAP is untouched. |
| W19 | Complete admin instructions, updated documentation and translations, and tests of all variants as the publication gate | **PARTIAL** | Wiki, nine locales and this document are updated; release notes for a version, tests of every variant, and the real-client DAV run are outstanding. |

The three FAIL verdicts on W04, W06 and W07 are the packages that remain (P10 write-back, P07b/P07d,
P08), and W10/W11 follow from P12. No item is marked PASS on the strength of code alone, and the three
"NOT RUN" entries are exactly the places where only a real device, account or registry could decide.

## End-to-end verification across the viewport matrix

The Playwright suite was run on every configured project after the drawer fix, because the
regression it found was a mobile-layout bug that unit and contract tests had passed straight
through:

| Project | Result |
| --- | --- |
| `chromium-desktop` | 123 passed, 0 failed, 59 skipped |
| `chromium-mobile` (Pixel 7) | 81 passed, 0 failed, 101 skipped |
| `chromium-tablet`, `chromium-mobile-390`, `chromium-mobile-landscape` | 171 passed, 0 failed, 204 skipped |

Re-run after the later interface work (the disconnect control, the readiness gates and the new
strings), and again after the connector-card spec was added: `chromium-desktop` **124 passed,
0 failed** and the two mobile projects **189 passed, 0 failed**, so the changes since the first run
are covered by this gate too, not only by the unit suites.

`chromium-tablet` runs only the `v3-*` specs by configuration, so its coverage is narrower than
the others by design.

Run it with:

```
cd frontend
PLAYWRIGHT_BROWSERS_PATH=$PWD/../.pw-browsers npx playwright test --project=chromium-desktop
```

This is the gate that should run alongside the unit suites for anything touching layout,
navigation or the drawer; it is the only one that caught the drawer covering the page after a
navigation while every unit test passed.

### What is gated, and what is only verified

Reading the workflows rather than assuming them gives this picture. "Verified" means it was run
manually during this work and passed; "gated" means a workflow runs it for a `dev` push.

| Layer | Local default | CI on push to `dev` | CI on PR |
| --- | --- | --- | --- |
| Backend and frontend unit / contract tests | runs | **gated** (`ci.yml`) | gated |
| Real-PostgreSQL integration (provider sync, token refresh, OAuth flow table, DAV) | skipped — needs `DB_*` | **not gated** (`ci.yml` has no database service; the PG workflow is PR-to-`main` and runs one specific file) | not gated |
| Browser E2E, five projects | skipped unless run explicitly | **not gated** (`conversation-v2-playwright.yml` is `pull_request`-only) | gated |

So two of the three layers were verified but never gated, and the work was integrated by pushing
directly to `dev`. That is the complete explanation for two real defects surviving many rounds of
per-round verification: the verification was real, and narrower than it looked.

Recipes to close the two gaps, left unapplied because CI cost is an operator decision:

- **Database suites** — add a job to `ci.yml` with a `postgres:16-alpine` service and the `DB_*`
  variables, then run the gated files, e.g.
  `npx vitest run src/services/providerAuthService.integration.test.ts src/services/providerTokenService.integration.test.ts src/services/providerOperations.integration.test.ts src/services/providers/google src/services/providers/microsoft src/routes/davPg.integration.test.ts`
  with `REQUIRE_DAV_POSTGRES=1`. These pass against a fresh database with the full migration chain,
  so the job would also prove the migrations apply.
- **Browser suite** — add `push: branches: [dev]` to `conversation-v2-playwright.yml`, or integrate
  through a pull request so its existing trigger applies.

The database recipe as a job, ready to paste into `ci.yml` beside the existing `backend` job (the
suite creates and drops its own rows, so it needs nothing but an empty migrated database):

```yaml
  backend-database:
    name: Backend (PostgreSQL integration)
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: mailflow_test
          POSTGRES_PASSWORD: mailflow_test
          POSTGRES_DB: mailflow_test
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U mailflow_test -d mailflow_test"
          --health-interval 5s --health-timeout 5s --health-retries 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm, cache-dependency-path: backend/package-lock.json }
      - run: npm ci
        working-directory: backend
      - name: Apply migrations (transactional, then the ones marked -- no-transaction)
        working-directory: backend
        env:
          PGPASSWORD: mailflow_test
        run: |
          set -euo pipefail
          for f in $(ls migrations/*.sql | sort); do
            if grep -qE '^--\s*no-transaction' "$f"; then
              psql -h 127.0.0.1 -U mailflow_test -d mailflow_test -v ON_ERROR_STOP=1 -q < "$f"
            else
              psql -h 127.0.0.1 -U mailflow_test -d mailflow_test -1 -v ON_ERROR_STOP=1 -q < "$f"
            fi
          done
      - name: Integration suites
        working-directory: backend
        env:
          DB_HOST: 127.0.0.1
          DB_PORT: '5432'
          DB_NAME: mailflow_test
          DB_USER: mailflow_test
          DB_PASSWORD: mailflow_test
          REQUIRE_DAV_POSTGRES: '1'
        run: |
          npx vitest run \
            src/services/providerAuthService.integration.test.ts \
            src/services/providerTokenService.integration.test.ts \
            src/services/providerOperations.integration.test.ts \
            src/services/providerConnectionService.integration.test.ts \
            src/services/providers/google src/services/providers/microsoft \
            src/routes/davPg.integration.test.ts
```

It is left unapplied because CI minutes are an operator decision, not because it is difficult. Two
caveats, so nobody mistakes it for something it is not: the **commands inside it are the ones used by
hand** throughout this work, but the **job itself has never been executed** — action versions and
cache paths are unverified — and the suite creates and drops its own rows, so it must not share a
database with another job.

What it buys beyond the tests: it proves the **migration chain applies to an empty database**, which
no other job in this repository currently does for a fresh install.

## Concurrency note on the refresh lease

A successful token store releases the refresh lease as part of writing the new token. That leaves
a window in which a worker that read an *expired* grant before another worker stored a fresh one
can acquire the now-free lease and refresh a second time with the token it read earlier. Where the
provider keeps its refresh token that is harmless; where it rotates one — Microsoft does — the
second exchange can invalidate the first worker's result, so the grant is now re-read under the
lease and a token that has become usable is returned instead of refreshing again.

Covered by the two-worker race test, which is the check that exposed the window: it failed once on
a fresh database, and passes repeatedly after the fix.

## Collection columns and their owners

`integration_collections` carries `enabled`, `source_access`, `user_access` and `dav_mode`. Only the
three connectors write them and **nothing reads them today**, so their values are inert: the
effective permissions come from `address_books`/`calendars` (`source`, `read_only`, `dav_mode`),
which the REST and DAV guards do read. `enabled` is the exception — the refresh schedule filters on
it.

That asymmetry is why a refresh no longer re-asserts any of them. Writing fields nothing reads looks
harmless, but `enabled` is read, and re-asserting it meant a disabled collection was switched back
on by the next sync. When P10/P12 give these columns readers, the sync must continue to leave them
to whoever owns them.

## Wired versus dormant

Reading the import graph rather than trusting the package list corrects two rows above: some of
this work is delivered and tested but not yet *called*. `syncCoordinator`'s leases run on every
connector sync, and the provider registry is consulted by the mail paths — but
`providerOperations.ts` (the journal and outbox) and `providers/capabilities.ts` have no production
importer.

That is not a defect: they were built as the vehicle for P10 write-back and the P12 cutover, and
those packages have not started. It does mean "delivered" in the table above should be read as
"the code exists and its tests pass", not "the application exercises it" — which is what the
per-package column now says for P01 and P03.

## Closed: PROPPATCH is answered

Clients such as Thunderbird and DAVx5 set a display name or colour on a collection with `PROPPATCH`.
Neither router handled it, so the request reached the framework default — which a client receiving it
on a collection that exists has every reason to read as "the collection is gone".

Both routers now refuse it with a `DAV:error` body saying that properties are managed by Inboxora,
and the tests assert the refusal writes nothing. Two mistakes made on the way, both worth keeping:
the response I first described was produced by the handler I had just added rather than by the
server, and my CardDAV handler compared against the calendar router's request attribute — this router
has always called it `cardavUserId` — so its guard refused before the reason could be written.

`PROPPATCH` is deliberately **not** listed in either router's `Allow` header, and that is the right
state rather than an oversight: the server refuses the operation, so advertising it would invite
clients to attempt something they cannot accomplish. The refusal follows RFC 4918 — `403` with a
`DAV:error` body — and both routers advertise `OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT` with
compliance `1, addressbook` / `1, calendar-access`, which matches what they implement.

`MKCALENDAR` remains deliberately unimplemented and documented as such in `caldav.ts`, with the
compliance classes that would imply unadvertised, which is correct.

## The integrations card now has browser coverage

No spec referenced the integrations status, the card or its sub-tabs, so the browser suite's green
result said nothing about the connector interface this work changed. `e2e/integrations-card.spec.ts`
now drives it from the payload it renders — it opens Settings → Integrations → *Dostawcy poczty
e-mail*, expands the provider rows, and asserts:

- the Microsoft requirement is stated and names the account it applies to;
- the Google recommendation still comes from the provider description that predates this work, so
  the card does not contradict it;
- each connected account is listed, and disconnecting issues a request for **that** account rather
  than a provider-wide guess.

The full desktop project with it is 124 passed, 0 failed.

The related finding stands and is not fixed here: that Google description asserts the app-password
alternative **unconditionally**, and agrees with `traditionalImapAvailableInInboxora` only because
the flag is a constant `true`. If the traditional route is ever removed, the description is the text
to make conditional.

## Reported flags that are constants

Two readiness fields remain reported and unread, and both are constants rather than probes, so the
next reader does not mistake them for wired capability:

- `google.traditionalImapAvailableInInboxora` — hardcoded `true` in both readiness builders. The
  Google card now reads it before claiming an app-password alternative exists, so the statement
  follows the flag instead of asserting the capability, but the flag itself is not computed from
  anything.
- `deviceCode.supported` — `true` for Microsoft, `false` for Google with `reason: 'not_supported'`,
  also constants. The cards do not need them, because the Google card has no device section and the
  Microsoft one is gated on `deviceCode.ready`.

If either capability ever becomes configurable, the flag has to be computed before the description
around it can be trusted.

## Reachability check on the mobile gesture

A preference-gated feature can pass every test and still be unreachable — off by default, with no
switch, or with its listeners attached to refs that no element fills. Checked directly: the
preference defaults to on, `AdminPanel` renders a switch bound to it, its value survives a reload
through the server-side allow-list, and the gesture hook's content, drawer and backdrop refs are
each attached to a real element. A contract test now pins those four facts, so removing the switch
or the allow-list entry fails the suite rather than silently making the feature unconfigurable.

## Closed: the Microsoft device switch is enforced server-side

The saved configuration's `deviceEnabled` was read only to *report* readiness, so switching the
method off left `POST /oauth/microsoft/device` starting it. The route now reads the stored
configuration and answers `403` with a clear message when the method is switched off, and treats an
absent or unreadable row as "not switched off" rather than failing closed. The endpoint previously
had **no test at all**; it now has five, covering the unauthenticated, unconfigured, switched-off,
working and unreadable-configuration paths.

## Closed: the provider and per-method switches are enforced

`integration_config` stores `enabled` per provider and `webEnabled` / `apiEnabled` per method, and
none of them gated anything — a provider or method switched off stayed startable while the readiness
card still called it enabled. Both halves are now done together, because either alone is an
inversion: the report would say "unavailable" over a working route, or a route would refuse behind a
card that offers it.

- `services/providerSwitches.ts` reads the stored switches, defaulting to on for an absent row or an
  unreadable configuration — a configuration that cannot be read has not switched anything off. It
  lives in a service, not beside the settings routes, so the route modules that enforce it stay
  importable on their own.
- Enforced in `GET /oauth/microsoft`, `GET /oauth/provider/microsoft`,
  `POST /oauth/microsoft/device` and `GET /oauth/google`.
- The readiness report derives `enabled`, the browser readiness and the device readiness from the
  same switches, so the card stops offering a flow at the moment the flow stops accepting it.
- Covered by tests at every site: provider off and method off for each of the three Microsoft
  entry points and the Google one, plus the existing readiness cases.

## Closed: disconnecting a connected provider account

A provider account can now be disconnected from the interface. `POST
/api/integrations/provider-connections/:id/disconnect` is owner-scoped and does the conservative
thing: it revokes the grant, deletes the stored access and refresh tokens instead of leaving them
encrypted at rest, takes the connection out of service so no schedule touches it, and disables its
collections so nothing refreshes. **It deletes no imported data** — contacts, calendars and events
stay visible, because removing them is a separate decision and not a side effect of disconnecting.
Reconnecting the same account reactivates it through the normal flow and re-links the same
collections by remote id.

`/api/integrations/status` reports the caller's own connections per provider — ids only, never a
credential — and the card lists them with a **Disconnect** control, so the state needed to use the
endpoint is visible rather than only available over the API.

## Known limitations of what is delivered

- Pulled Google and Microsoft contacts and Google calendars are **read-only** in Inboxora: REST and
  DAV refuse to edit a collection whose source is not local, and the source is the writer. The
  authorization requests read-only scopes to match, so nothing asks for access it never uses.
- Imported collections also **cannot be deleted** from Inboxora: the delete path requires a local
  source, so an imported book or calendar stays visible (frozen after a disconnect) rather than being
  removable. That is deliberate — the source is the writer, so removing the copy would only invite the
  next refresh to recreate it (the foreign key clears the link rather than failing, so the delete
  would appear to work and silently undo itself). Pinned by tests for all three sources.
- An event Inboxora owns because invitations were sent for it is protected on every write path: the
  CalDAV `PUT` refuses it, the invitation ingest respects its sequence, and the `.ics` import now
  leaves it unchanged and reports the count rather than replacing it. The DAV
  side of that rule is pinned by tests for both protocols, including that a provider collection
  advertises read only even when its DAV mode says read-write.
- Recurring Google events keep their timezone through a **generated VTIMEZONE**; the generator reads
  the platform time-zone database, so a rule change needs no code change.
- Microsoft Graph calendar events are **not** imported yet, so they cannot hit the Windows→IANA
  timezone naming problem the plan warns about.
- The provider refresh runs in-process on a timer (default 15 minutes, one pass 30 seconds after
  start). There is no external scheduler, so a stopped server does not refresh — by design for now.
- Provider error codes surfaced in the UI are the recorded domain codes, not the providers' raw
  messages.

## How to continue the remaining packages

Entry points and constraints discovered while building what exists. They are recorded so the next
session does not have to rediscover them, not as a design that has been agreed.

### State when this was written (measured at `9e2b1ddb` on `dev`, before the documentation commits that followed it)

Everything below was green at that commit: backend **2267** unit tests, frontend **2655** plus a
production build, **95** database integration tests on a fresh PostgreSQL 16 with the full
109-migration chain, and the browser matrix at **124** (desktop) and **189** (two mobile viewports).

The counts grew while the section below was being written, which is the point of dating them: each
`docs:` commit that follows adds no tests, so a reader can trust the numbers against that commit and
should re-run the gates rather than assume a later one matches.

Two of those layers are **not** gated by CI — `ci.yml` has no database service, and the Playwright
workflow is `pull_request`-only — so run them by hand before pushing:

```
cd backend && TMPDIR=/tmp npm test
DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=… DB_USER=… DB_PASSWORD=… REQUIRE_DAV_POSTGRES=1 \
  npx vitest run src/services/providerAuthService.integration.test.ts \
  src/services/providerTokenService.integration.test.ts \
  src/services/providerOperations.integration.test.ts \
  src/services/providerConnectionService.integration.test.ts \
  src/services/providers/google src/services/providers/microsoft \
  src/routes/davPg.integration.test.ts
cd frontend && PLAYWRIGHT_BROWSERS_PATH=$PWD/../.pw-browsers npx playwright test --project=chromium-desktop
```

Open findings for the next session, each with its evidence in this document: the Microsoft
device switch and the provider/per-method switches are **closed** (enforced, tested); the disconnect
gap is **closed** (endpoint, card control, reconnection, and its consequences verified on a real
database); the integrations card now **has** browser coverage. Still open: the pre-existing Google
provider description asserts an app-password alternative unconditionally, and two readiness flags
(`traditionalImapAvailableInInboxora`, `deviceCode.supported`) are reported constants rather than
probes — if either capability becomes configurable, it must be computed before the text around it
can be trusted.

**P07b — Microsoft Graph mail adapter.** Reuse `services/providers/microsoft/graphApiClient.ts` and
take `graphContactsSync.ts` as the template: discovery, `integration_collections`, `remote_object_links`,
a cursor in `sync_states` under the P03 lease, and per-object idempotent upserts. The open problem is
**not** the Graph calls but the account model: messages, folders and threads are keyed to
`email_accounts` (an IMAP account), while a provider grant belongs to a `provider_connection`, so the
adapter has to target an account. The plan is explicit that this switch is an explicit migration with
recorded intent, a configuration revision check and a checkpoint — **not** a silent transport change,
and the old engine must be stopped before the new one writes. `provider_operations.ts` and the
operation journal already exist for that work; read §12 of the plan before choosing the shape.

**P07d — Microsoft Graph calendar adapter.** The client, `utils/icalTimezone.ts` and
`utils/icalText.ts` already exist, and the Google calendar adapter
(`googleCalendar.ts` + `googleCalendarSync.ts` + `googleCalendarMerge.ts`) is a close template,
including the merge that keeps a series and its overrides in one resource. The hazard is time zones:
Graph returns **Windows** zone names (`Central European Standard Time`), which `icalTimezone.ts`
cannot resolve because it reads IANA ids. Decide deliberately between requesting
`Prefer: outlook.timezone="UTC"` (exact instants, but a local-time recurring series would drift
across DST unless the RRULE is converted) and adding a Windows→IANA table (keeps wall time, needs
maintenance). Do not ship either without a test that pins a summer and a winter occurrence.

**P08 — Gmail adapter.** `googleApiClient.ts` and `googleContactsSync.ts` are the templates; labels
map to folders and Gmail threads to the local thread model. It shares the P06/P07b account-model
question and should be designed together with it rather than twice.

**P06 — what is already enforced, and why the obvious slice is not one.** `send.ts` already
rejects more than 100 attachments and a total above 25 MB, and the HTTP body limit is 35 MB with a
route-aware 413 message. A *per-file* limit on top of that would be redundant while it equals the
total, and making it smaller is a product policy decision rather than something to infer — so the
real remaining work is (a) the MIME/content-type dimension, (b) counting **forwarded** attachments
against the same total, which today are validated by count only and whose sizes are known only after
the IMAP fetch, and (c) the durable ledger with draft preservation. Those need a limit definition
shared with the composer rather than a constant chosen inside the route.

**P10 — external CalDAV/CardDAV write-back.** The read-only pieces and the `remote_object_links`
rows are in place, and `provider_operations.ts` was written for exactly this: a write is an
operation with a generation, a terminal state and a typed failure, and a conflict must surface as a
domain code rather than an overwrite. The existing rule that a collection whose `source` is not
local refuses writes is what keeps an unimplemented write-back from silently doing nothing.

**P13/P14.** Needs the two decisions below before anything can be published: the release notes file
is named after a version, and publishing the images needs registry authorization.

## Open questions for the maintainer

1. **Release version** for `docs/wiki/Release-notes-<version>.md`. The repository requires release
   notes for every user-visible change and does not allow inferring a version, so the entries for
   this work are collected under `## [Unreleased]` in `docs/CHANGELOG.md` until a version is chosen.
2. **Registry/CI authorization** to publish `ghcr.io/dragonk/inboxora-backend:dev` and
   `...-frontend:dev` and smoke-test the pair (P14).
