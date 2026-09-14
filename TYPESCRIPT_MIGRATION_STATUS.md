# TypeScript migration — status (dev branch)

Last updated: round 247 (DbRow merge + E2E green).

## Final state

| Area | State |
|---|---|
| Backend source | 305 files, 100% `.ts` (0 `.js`) |
| Frontend source | 238 files, 100% `.ts`/`.tsx` (0 `.js`/`.jsx`) |
| Total `.ts`/`.tsx` in both `src` trees | 543 |
| E2E specs | `.ts`; Playwright run: **370 passed, 0 failed**, 357 skipped (727 total) |
| Backend typecheck | `tsc --noEmit` → **0 errors** |
| Frontend typecheck | `tsc --noEmit` → **0 errors** |
| Backend tests | vitest: **1785 passed**, 0 failed (36 skipped) |
| Frontend tests | node:test + tsx: **2335 passed**, 0 failed |
| Backend build | `tsc -p tsconfig.build.json` → `dist/index.js` present |
| Frontend build | `vite build` → `dist/index.html` present |
| Lint | backend + frontend `eslint --max-warnings 0` clean |
| Published images | `ghcr.io/dragonk/inboxora-backend:dev` and `-frontend:dev` built by **Publish to GHCR** at SHA `d9f76d9`; the stack was started and answered `/api/health` |
| `@ts-nocheck` / `@ts-ignore` / `@ts-expect-error` | **0 files** |
| `any` occurrences | frontend **0**; backend **0** — the dynamic-SQL boundary was removed |

### Dynamic SQL rows are typed

`backend/src/services/db.ts` no longer exports `type DbRow = any`. It is
`Record<string, unknown>`, and the call sites that read dynamic rows declare the columns they
use (`query<{ ... }>(...)`). The change was carried in the `typescript/dbrow` branch (58 files,
+411/-321) and merged into `dev`. Removing the boundary surfaced **79 real backend findings**
that `any` had been hiding — they were fixed, not suppressed.

## Remaining work (documented, measured, NOT done)

**Strict mode is enabled but not clean.** Both projects carry `tsconfig.strict.json` with
`strict: true` and `noImplicitAny: true`; that file is the reference mode for this work:

```bash
cd backend  && npx tsc -p tsconfig.strict.json --noEmit   # 1224 findings
cd frontend && npx tsc -p tsconfig.strict.json --noEmit   # 2073 findings
```

**3297 findings in total.** Dominant code TS7006 (`noImplicitAny` on function parameters), then
TS2345/TS2322 (argument and assignment mismatches), TS7031 (destructured bindings) and TS18048
(`possibly undefined`). **None is suppressed** — no `@ts-ignore`, no `@ts-nocheck`, no `as any`
— so the whole remainder is visible in the build.

### What works, and what was measured not to

- **Shared declarations work.** Typing one helper, state or queue fixed 37 findings in a single
  pass (the read/star mutation lanes, the compose draft fields), and 40 more came from typing the
  pg mock's `sql` tuple and the `value` callback.
- **Parameter-name rules do not.** Two engines were built and measured: a blanket `(name) =>`
  to `(name: string) =>` over 193 (backend) and 282 (frontend) names drove the counts from 1224
  to **1463** and 2076 to **2373** and left hundreds of ordinary-build errors. Most implicit-any
  parameters are not strings, so the rule is rejected by the guard and the files are restored.
- **Per-site semantic typing is the reliable route**, at roughly 20-40 findings per focused round.

Every defect discovered while typing was fixed in the code; the running report is
`TYPESCRIPT_MIGRATION_FIXES.md` (68 sections).

## Tooling / config
- `backend/tsconfig.json` (typecheck, `noEmit`, `allowJs: false`), `backend/tsconfig.build.json`.
- `frontend/tsconfig.json` (Bundler resolution, `react-jsx`).
- Backend runtime: `start` → `node dist/index.js`, `dev` → `tsx watch src/index.ts`.
- Backend `Dockerfile`: multi-stage deps → build (tsc) → runtime (`dist`).
- `frontend/index.html` entry → `/src/main.tsx`.
- ESLint flat configs handle `.ts`/`.tsx`; vitest setup/config in `.ts`.
- Playwright `testMatch`/`testIgnore` on `.ts`.
- Calendar projection worker: `.ts` worker + `--import tsx` in source, emitted `.js` in the build.
- `packages/electron/*.cjs`, `packages/scripts/*.cjs` intentionally remain CommonJS entry points.

## Verification commands

```bash
cd backend  && npm run typecheck && npm run build && npm test && npm run lint
cd frontend && npm run typecheck && npm run build && npm test && npm run lint
cd frontend && npx playwright test --list
```
