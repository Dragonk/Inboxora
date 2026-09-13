# Release notes 4.0.1

**Status:** released 2026-09-13 · **Previous version:** 4.0.0 · **Type:** patch (no new functionality)

## What this release is

4.0.1 changes **how Inboxora is written, not what it does**. The entire codebase — backend and
frontend — was migrated from JavaScript to TypeScript. No feature was added, no database migration
was introduced and no configuration, API or DAV contract changed. Upgrading from 4.0.0 is a
drop-in image update.

## Why migrate

The application was plain JavaScript with no compiler in the loop. That is fine until it is not:
a misspelled property, an import that was never added, a callback the caller does not pass, or a
comparison that can never be true all look correct and only fail at runtime — on the one code path
a user happens to take, often in a rare state, often in production.

TypeScript moves those checks into the build. The migration was deliberately done **without**
`@ts-nocheck`, without blanket `as any` casts and without suppressions such as `@ts-ignore`:
every file had to satisfy the compiler through real types and real fixes. That turned the migration
itself into a systematic audit of 535 source files.

## What the audit found

Typing the code surfaced real defects that JavaScript never complained about. The most consequential
ones:

- **A missing import in an AI-result component.** It called `renderMarkdown` without importing it,
  so every AI summary or custom action output would have thrown at render time.
- **A context-menu guard that could never fail.** The folder context menu checked
  `e.pointerType` — a property that does not exist on a `MouseEvent` — so the desktop-only
  restriction was always true.
- **A test double with the wrong shape.** It returned an array where the production code expects a
  `Set` and calls `.has()` on it.
- **Dead fallback code.** A metadata helper read a `references` field that the parser it calls
  never returns.
- **Contracts that disagreed with their implementations** — helpers that returned `null` while
  documented as `number`/`string`, an extra argument passed to a four-parameter function, and a
  service that accepted both a `'true'` string and a boolean for the same flag.
- **Date arithmetic on objects** (`new Date(a) - new Date(b)`) in sorting and range code, which is
  only accidentally correct; replaced with `.getTime()`.
- **Stream handling without narrowing**, request/response shapes read by the client but never
  produced by the server, and untyped frontend style objects that hid a missing React attribute.

The full list, including the smaller items, is in `TYPESCRIPT_MIGRATION_FIXES.md` at the repository
root.

## What changed for you

- **Nothing in your deployment.** Same images, same environment variables, same database, same
  upgrade procedure. There is no migration step and nothing to reconfigure.
- **Nothing in the interface.** Screens, behaviour and data are identical.
- For **developers**: the sources are TypeScript, so `npm run typecheck` (`tsc --noEmit`) is now
  part of the local loop, and `npm run lint`/`npm test` are unchanged. The backend still builds
  to `dist/` with `npm run build` and still starts with `npm start`.

## Known follow-up work

Two items are deliberately left for later, and neither affects runtime behaviour:

- **`strict` / `noImplicitAny` remain off.** Enabling strict mode was measured at 1609
  (backend) and 2172 (frontend) additional findings, dominated by untyped function parameters.
  Typing those signatures is a multi-step refactor rather than part of this patch.
- **One typed boundary keeps an explicit `any`**: `type DbRow = any` in
  `backend/src/services/db.ts`, the row type of dynamic SQL. Query parameters are typed
  `unknown[]` and callers narrow what they read; typing rows as `Record<string, unknown>` was
  measured to cascade into ~220 errors across ~200 call sites.

See `docs/CHANGELOG.md` for the change-by-change entry and `TYPESCRIPT_MIGRATION_STATUS.md` for the
verified state.

