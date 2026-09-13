# TypeScript migration — status (dev branch)

Last updated: after commit `26826b9`.

## What is done

| Area | State |
|---|---|
| Backend source | 299 files, 100% `.ts` (0 `.js`) |
| Frontend source | 236 files, 100% `.ts`/`.tsx` (0 `.js`/`.jsx`) |
| E2E specs | 35 files `.ts` (Playwright discovers 727 tests in 28 files) |
| Backend typecheck | `tsc --noEmit` → 0 errors |
| Frontend typecheck | `tsc --noEmit` → 0 errors |
| Backend tests | vitest: 1785 passed, 0 failed (36 skipped) |
| Frontend tests | node:test + tsx: 2335 passed, 0 failed |
| Backend build | `tsc -p tsconfig.build.json` → `dist/`; `node dist/index.js` resolves |
| Frontend build | `vite build` succeeds |
| Lint | backend + frontend `eslint --max-warnings 0` clean |

### Tooling / config
- `backend/tsconfig.json` (typecheck, `noEmit`), `backend/tsconfig.build.json` (emit to `dist`).
- `frontend/tsconfig.json` (Bundler resolution, `react-jsx`).
- Backend runtime: `start` → `node dist/index.js`, `dev` → `tsx watch src/index.ts`.
- Backend `Dockerfile`: multi-stage deps → build (tsc) → runtime (`dist`).
- `frontend/index.html` entry → `/src/main.tsx`.
- ESLint flat configs handle `.ts`/`.tsx`; vitest setup/config moved to `.ts`.
- Playwright `testMatch`/`testIgnore` updated to `.ts`.
- Packages `electron/*.cjs` and `scripts/*.cjs` intentionally remain CommonJS Node entry
  points (run directly by Node/Electron; migrating them needs a dedicated build step).

### Type infrastructure added
- `backend/src/types/express-session.d.ts` — session fields (userId, oauth/oidc, TOTP…).
- `backend/src/types/express.d.ts` — Request DAV/push fields.
- `backend/src/services/imapManager.ts` — `declare` field block for runtime state.
- `frontend/src/types/global.d.ts` — `window.inboxoraNative`.

## Remaining debt (not complete)

`// @ts-nocheck` is still present on **234 files** (backend 133, frontend 101). These files
typecheck as `any`; the remaining work is to remove the pragma file-by-file and fix the
underlying errors. Measured error volume when `@ts-nocheck` is removed:

- Backend: ~1074 errors (≈472 in non-test source).
- Frontend: ~1522 errors (≈1518 in source).

Dominant patterns to fix first:

**Backend**
- `Property 'error' does not exist on type 'unknown'` / `'id' does not exist on 'unknown'` — narrow `catch`/`JSON` results.
- `req.query` values typed `string | ParsedQs | …` — coerce with `String(...)` or a query helper.
- `new Promise()` missing executor type; `Error.statusCode`/`code` — add an HTTP error type.
- Redis client mock type mismatches in tests.

**Frontend**
- `CSSProperties` mismatches (string vs literal unions) — annotate style objects.
- Store selectors returning `unknown` — type the zustand store state.
- `EventTarget.style` — narrow event targets.
- Component prop contracts (e.g. missing `required`) — align prop types.

## Suggested next steps

1. Remove `@ts-nocheck` from the smallest files first (few errors each), fix, commit.
2. Fix shared root causes once and re-run: HTTP error type, query-param helper,
   zustand store types, CSSProperties annotation.
3. Re-measure after each batch: `backend: npx tsc --noEmit | grep -c 'error TS'`.
4. Only then enable `strict` (currently `strict: false`, `noImplicitAny: false`).

## Verification commands

```bash
cd backend  && npm run typecheck && npm run build && npm test && npm run lint
cd frontend && npm run typecheck && npm run build && npm test && npm run lint
cd frontend && npx playwright test --list
```
