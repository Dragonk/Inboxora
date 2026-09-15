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
itself into a systematic audit of 551 source files.

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

The audit also corrected unsafe Express query handling, external OAuth/OIDC, CardDAV, Todoist and
AI-provider response boundaries, IMAP and calendar-projection result contracts, and mismatched
conversation-action inputs. The complete release record is maintained in
[`docs/CHANGELOG.md`](../CHANGELOG.md), not in separate migration reports at repository root.

## What changed for you

- **Nothing in your deployment.** Same images, same environment variables, same database, same
  upgrade procedure. There is no migration step and nothing to reconfigure.
- **Nothing in the interface.** Screens, behaviour and data are identical.
- For **developers**: the sources are TypeScript, so `npm run typecheck` (`tsc --noEmit`) is now
  part of the local loop, and `npm run lint`/`npm test` are unchanged. The backend still builds
  to `dist/` with `npm run build` and still starts with `npm start`.

## Type-safety completion

Strict checking is now the default in both projects: their primary `tsconfig.json` files enable
`strict` and `noImplicitAny`, and `tsconfig.strict.json` remains a compatibility entry point to
the same configuration. Both `npm run typecheck` and `npm run typecheck:strict` complete with
**0 errors** for backend and frontend.

The source tree has no TypeScript suppression pragmas, ESLint-disable pragmas, or explicit
`any`/`as any` escapes. The former dynamic SQL row boundary is `Record<string, unknown>` and every
consumer declares or narrows the shape it needs. CI enforces the strict typecheck before building
or testing.

See [`docs/CHANGELOG.md`](../CHANGELOG.md) for the complete change and fix record. The developer
verification commands are documented in the development guide.

