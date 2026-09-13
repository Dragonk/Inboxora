# TypeScript migration — status (dev branch)

Last updated: after the final cleanup rounds (type-clean, zero `any`).

## Final state

| Area | State |
|---|---|
| Backend source | 299 files, 100% `.ts` (0 `.js`) |
| Frontend source | 236 files, 100% `.ts`/`.tsx` (0 `.js`/`.jsx`) |
| E2E specs | `.ts` (Playwright discovers 727 tests in 28 files) |
| Backend typecheck | `tsc --noEmit` → **0 errors** |
| Frontend typecheck | `tsc --noEmit` → **0 errors** |
| Backend tests | vitest: **1785 passed**, 0 failed (36 skipped) |
| Frontend tests | node:test + tsx: **2335 passed**, 0 failed |
| Backend build | `tsc -p tsconfig.build.json` → `dist/`; `node dist/index.js` resolves |
| Frontend build | `vite build` succeeds |
| Lint | backend + frontend `eslint --max-warnings 0` clean |
| `@ts-nocheck` / `@ts-ignore` / `@ts-expect-error` | **0 files** |
| `any` occurrences | frontend **0**; backend **0** except one documented boundary alias |
| Bug report | `TYPESCRIPT_MIGRATION_FIXES.md` (all defects found and fixed) |

### Documented boundary exception

`backend/src/services/db.ts` declares `export type DbRow = any` — a row from a dynamic SQL
query. Query parameters are typed `unknown[]`; row values stay untyped at this single
database boundary because columns differ per query. Typing rows as
`Record<string, unknown>` was measured to cascade into ~220 errors across ~200 call sites and
is tracked as a separate, dedicated refactor.

### Tooling / config
- `backend/tsconfig.json` (typecheck, `noEmit`), `backend/tsconfig.build.json` (emit to `dist`).
- `frontend/tsconfig.json` (Bundler resolution, `react-jsx`).
- Backend runtime: `start` → `node dist/index.js`, `dev` → `tsx watch src/index.ts`.
- Backend `Dockerfile`: multi-stage deps → build (tsc) → runtime (`dist`).
- `frontend/index.html` entry → `/src/main.tsx`.
- ESLint flat configs handle `.ts`/`.tsx`; vitest setup/config moved to `.ts`.
- Playwright `testMatch`/`testIgnore` updated to `.ts`.
- Calendar projection worker uses the `.ts` worker + `--import tsx` in source and the emitted
  `.js` in the build.
- Packages `electron/*.cjs` and `scripts/*.cjs` intentionally remain CommonJS Node entry
  points (run directly by Node/Electron; migrating them needs a dedicated build step).

### Type infrastructure added
- `backend/src/types/express-session.d.ts`, `express.d.ts`, `errors.d.ts`.
- `backend/src/utils/query.ts` (typed `req.query` access), `backend/src/test/net.ts`.
- `backend/src/test/json.ts` (`JsonBody`) for route-test JSON assertions.
- `frontend/src/types/global.d.ts` (native bridge globals, React augmentations).

## How masking was avoided

The first pass used `@ts-nocheck`/`as any` to make the compiler quiet; that was reverted.
Every file was then fixed by declaring real interfaces, narrowing `unknown`, correcting wrong
call signatures and, where the types revealed genuine bugs, fixing the code — not the types.
The full list of discovered defects (dead branches, undefined imports, wrong Set/array mocks,
always-true guards, date arithmetic, missing runtime entrypoints, …) is in
`TYPESCRIPT_MIGRATION_FIXES.md`.

## Verification commands

```bash
cd backend  && npm run typecheck && npm run build && npm test && npm run lint
cd frontend && npm run typecheck && npm run build && npm test && npm run lint
cd frontend && npx playwright test --list
```
