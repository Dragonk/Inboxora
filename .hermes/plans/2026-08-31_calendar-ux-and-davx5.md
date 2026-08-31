# Inboxora Calendar UX and DAVx5 reliability — implementation plan

> **For Hermes:** Execute sequentially using `subagent-driven-development`: one bounded task at a time, strict RED → GREEN → REFACTOR, then independent spec and quality/security review.

**Goal:** Repair production DAV discovery for DAVx5 and evolve Calendar into a localised, accessible desktop/mobile experience with user preferences for calendar behaviour and mobile navigation placement.

**Branch/worktree:** `feat/calendar-ux-davx5` at `/opt/data/worktrees/inboxora-calendar-ux`, created from released `origin/main` commit `9fc779e`.

**Non-negotiable rules:**
- All user-visible strings use i18n keys present in all nine locales; run the full i18n test after each UI slice.
- Calendar imports remain read-only; only local calendars may be mutated.
- Never place secrets in fixtures, output or source; synthetic DAV credentials use `[REDACTED]`.
- Do not release or merge without a reviewable PR, exact-SHA CI and user-test gate.

## Ordered slices

1. **DAVx5 discovery proxy repair** — `frontend/nginx.conf` must proxy `/.well-known/carddav`, `/.well-known/caldav`, `/carddav/`, and `/caldav/` to the backend in both HTTP and HTTPS server blocks.  Test the config contract first; run frontend test/lint/build.  Validate with nginx if available.
2. **DAV discovery protocol regression coverage** — test the backend redirect contract for `OPTIONS` and `PROPFIND` through well-known routes without credentials being logged. Document the standard device URLs in the DAV settings UI.
3. **Event reminder data model** — migration and API validation for zero or more local event reminders. Include event ownership/local-calendar checks, normalised lead-time values and safe defaults.
4. **User calendar preferences** — persist and hydrate `weekStartsOn` and default reminder configuration via the existing preferences API/store. Add backend allow-list/validation and unit tests.
5. **Calendar range helpers** — date-fns-based pure helpers for month/full-week/work-week ranges, locale-aware week start and today classification. Test Sunday/Monday starts and daylight-saving boundaries.
6. **Desktop calendar layout** — month / full-week / work-week selector, Outlook-inspired timed grid, all-day lane, visibly highlighted current day, accessible navigation and no hard-coded strings.
7. **Mobile calendar layout** — eliminate horizontal overflow; provide a touch-safe agenda/day interaction and a large primary add-event affordance.
8. **Full mobile event editor** — title, calendar, all-day, start/end, description, location, URL/organizer where supported, reminders and lead time. Ensure keyboard safe-area handling and edit/delete affordances.
9. **Mobile navigation placement** — user preference: top by default, bottom option; persist/hydrate it, expose an accessible Settings control and test both layouts.
10. **Contacts top-toolbar cleanup** — remove redundant Contacts icon/button from `MessageList.jsx`; preserve Sidebar desktop/mobile access and tests.
11. **i18n completion and UX accessibility pass** — add translations to all locale files; run i18n coverage/uniqueness checks; verify labels, errors, dates and empty states are translated.
12. **Integration/PR gate** — full backend/frontend suites, lint, build, relevant Playwright/mobile E2E, independent security/spec reviews, commit/push and draft PR. Do not merge or release until the user has tested and approved.

## Acceptance evidence

- DAVx5 well-known probes receive backend 308 redirects and subsequent DAV `OPTIONS`/`PROPFIND` are not swallowed by SPA routing.
- Every new visible Calendar and settings string is keyed in all supported locales.
- Full-week/work-week/month views use the configured first day of week and highlight today.
- Mobile layout has no horizontal viewport overflow and event creation is usable, complete and accessible.
- Reminder defaults are user-owned, persisted and applied only to newly created events.
