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
itself into a systematic audit of 550 source files.

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

One item is deliberately left for later, and it does not affect runtime behaviour:

- **`strict` / `noImplicitAny` are enabled but not yet clean.** Both projects carry a
  `tsconfig.strict.json` that turns them on, and it is the reference mode for this work:

  ```bash
  cd backend  && npx tsc -p tsconfig.strict.json --noEmit   # 1224 findings
  cd frontend && npx tsc -p tsconfig.strict.json --noEmit   # 2073 findings
  ```

  That is **3297** findings in total, overwhelmingly `noImplicitAny` on function parameters and
  destructured bindings. **None is suppressed** - there is no `@ts-ignore`, no `@ts-nocheck`,
  no `as any` - so every one is visible in the build. Closing them is a per-site typing task:
  the shared-declaration route works (typing one helper or state fixed 37 findings in a single
  pass), while mechanical rules over parameter names were measured to make the total *worse*,
  because most untyped parameters are not strings. Start from the largest files:
  `backend/src/services/imapManager.ts` (58), `backend/src/routes/auth.ts` (39),
  `frontend/src/components/AdminPanel.tsx` (170), `frontend/src/components/MessageList.tsx` (162).

  The previous typed boundary - `type DbRow = any` - has been **removed** as part of 4.0.1: it
  is `Record<string, unknown>` now, with the call sites that read dynamic rows declaring their
  columns.

See `docs/CHANGELOG.md` for the change-by-change entry and `TYPESCRIPT_MIGRATION_STATUS.md` for the
verified state.

