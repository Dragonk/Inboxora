# Implementation status against the v4 plan (P00–P14)

This is the honest per-package status of the v4 delivery (`Inboxora-plan-wdrozenia-v4.md`) on the
integration branch `dev`. It records what is **verified and integrated**, what is partial, and what
has not been started, with the commit that delivered each piece so the claims can be checked with
`git show <sha>`.

Nothing here is aspirational: a package is only marked delivered when its behaviour is covered by
tests — including integration tests against a real PostgreSQL where persistence, leases or cursors
are involved — and merged to `origin/dev`.

Last verified on `dev` at `e32274f9`: backend typecheck, lint and **2226 tests**; frontend
typecheck, lint, production build and **2644 tests**. `main` has not been touched by this work.

## Status

| Package | Status | Delivered (commit) | Missing |
| --- | --- | --- | --- |
| P00 — preparation/audit | n/a | — | Prepared against the existing baseline; no code artefact. |
| P01 — shared provider contracts | delivered | `abbe2b9b` | — |
| P02 — additive schema (connections, grants, remote links, operation journal, outbox, notice preferences) | delivered | `abbe2b9b` (connections/grants/remote links, `0101`), `78b8c182` (journal/outbox, `0102`), `d4592756` (`0104`), `d7b8ceb9` (`0105`), `1a84536d` (`0106`) | `account_notice_preferences` exists but is unused until P12. |
| P03 — operation journal, sync leases, domain outbox | delivered | `78b8c182` | — |
| P04 — OAuth flows and token service | mostly delivered | `ee788ca8` (Google web flow), `d4592756` (single-flight refresh + CAS), `524a5f00` (Microsoft refresh), `c30d13ba` (Microsoft Graph provider flow), `d4927e09` (Google flow in the UI), per-feature Google connect buttons | Provider **device-code** authorization (the mailbox device flow exists; the Graph provider flow is browser-only). |
| P05 — mobile drawer gesture | delivered | `f76e1a40` | — |
| P06 — send/draft ledger, attachment and MIME limits | **not started** | — | Durable upload/send ledger, separated file/total/MIME/HTTP limits, draft preservation on failure. |
| P07 — native Microsoft Graph adapters | **partial** | `524a5f00`, `c30d13ba`, `a9a3f975` (contacts), `d545ff45`, `c08fb7ae`, `f4d4fac1` | **Graph mail adapter** (blocks P12), Graph calendar adapter, provider device flow. |
| P08 — Gmail API mail adapter | **not started** | — | Labels/folders, message and thread ingest, attachments. |
| P09 — Google Calendar/People + MS Graph calendar/contacts | **partial** | `29bf023e` (People), `71558193` + `c8ea8383` (Calendar with generated VTIMEZONE), `d4927e09` + `8aff1d1e` (UI), `a2973f94` (schedule); Microsoft contacts under P07 | Microsoft Graph **calendar** adapter. |
| P10 — external CalDAV/CardDAV read-write, ICS/VCF/CSV import | **partial** | `6cf1a4bf` (vCard import), `6cccd470` (iCalendar import); Google CSV import pre-existed | External CalDAV/CardDAV **write-back** client. |
| P11 — DAV server hardening | mostly delivered | `0afab53d` (discovery/classes), `58f2c809` (strong `If-Match`), `d7b8ceb9` (per-collection visibility/mode), `1a84536d` (per-password ceiling), `db97a1af` (WebDAV `If` header), `6c6584cb` + `811a50d8` (connector status visibility) | Write-through result reporting, any remaining `DAV:` classes the plan lists. |
| P12 — account migration/cutover, MS-required and Google-recommended notices | **not started** | — | Deliberately blocked: a notice must not point users at a mail transport that does not exist yet (needs P07b/P08). |
| P13 — hardening, E2E, release notes | **partial** | `065b3f86` (provider setup procedure); i18n kept at nine locales throughout | End-to-end suite for the new flows, release notes for a chosen version. |
| P14 — final integration, CI, publish images | **not started** | — | Publish both `:dev` images and smoke-test the pair. Needs a release version and registry authorization. |

## Verification performed on a fresh database

The whole chain was re-applied **from zero** on an empty PostgreSQL 16 and every gated integration
suite was then run against that database, so the provider stack is proven on a schema a new
installation would actually have rather than on one evolved in place:

- all 109 migrations apply in order with no error, and the provider tables
  (`provider_connections`, `oauth_grants`, `integration_collections`, `remote_object_links`,
  `provider_operations`, `domain_outbox`, `sync_states`, `account_notice_preferences`) all exist
  afterwards;
- 44 integration tests pass across seven suites: the provider authorization-flow table, Google and
  Microsoft token refresh (including the two-worker race), the operation journal and outbox, the
  Google and Microsoft contact syncs, the Google calendar sync, and the DAV HTTP integration.

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

## Known limitations of what is delivered

- Pulled Google and Microsoft contacts and Google calendars are **read-only** in Inboxora: REST and
  DAV refuse to edit a collection whose source is not local, and the source is the writer. The DAV
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
