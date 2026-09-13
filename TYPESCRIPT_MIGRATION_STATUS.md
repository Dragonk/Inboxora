# TypeScript migration — status (dev branch)

Last updated: final verification round.

## Final state

| Area | State |
|---|---|
| Backend source | 299 files, 100% `.ts` (0 `.js`) |
| Frontend source | 236 files, 100% `.ts`/`.tsx` (0 `.js`/`.jsx`) |
| Total `.ts`/`.tsx` in both `src` trees | 543 |
| E2E specs | `.ts` (Playwright: 727 tests in 28 files) |
| Backend typecheck | `tsc --noEmit` → **0 errors** |
| Frontend typecheck | `tsc --noEmit` → **0 errors** |
| Backend tests | vitest: **1785 passed**, 0 failed (36 skipped) |
| Frontend tests | node:test + tsx: **2335 passed**, 0 failed |
| Backend build | `tsc -p tsconfig.build.json` → `dist/index.js` present |
| Frontend build | `vite build` → `dist/index.html` present |
| Lint | backend + frontend `eslint --max-warnings 0` clean |
| `@ts-nocheck` / `@ts-ignore` / `@ts-expect-error` | **0 files** |
| `any` occurrences | frontend **0**; backend **0** except one documented boundary alias |

### Documented boundary exception

`backend/src/services/db.ts` declares `export type DbRow = any` — a row from a dynamic SQL
query. Query parameters are typed `unknown[]` and `DbClient` exposes the contract; row values
stay untyped at this single database boundary because columns differ per query. Typing rows as
`Record<string, unknown>` was measured to cascade into ~220 errors across ~200 call sites and is
tracked as a separate refactor.

## Remaining work (documented, measured, NOT done)

**Strict mode is not enabled** (`strict: false`, `noImplicitAny: false` in both tsconfigs).
Measured volume:

| Measurement | Backend | Frontend |
|---|---|---|
| `strict: true` | 1609 | 2172 |
| `noImplicitAny: true` alone | 3502 → **2846** (reduced) | 3599 |

The dominant remainder is TS7006 (untyped function parameters) — a large, multi-round refactor.
Progress so far removed 656 findings from the backend by typing real signatures (no flag flip,
so the branch stayed green throughout).

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
