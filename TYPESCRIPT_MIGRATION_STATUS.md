# TypeScript migration — completed (dev branch)

## Final state

| Area | State |
|---|---|
| Backend source | 100% `.ts`; 0 `.js` files in `backend/src` |
| Frontend source | 100% `.ts`/`.tsx`; 0 `.js`/`.jsx` files in `frontend/src` |
| Backend primary typecheck | `npm run typecheck` → **0 errors** |
| Frontend primary typecheck | `npm run typecheck` → **0 errors** |
| Backend strict compatibility check | `npm run typecheck:strict` → **0 errors** |
| Frontend strict compatibility check | `npm run typecheck:strict` → **0 errors** |
| Backend unit tests | vitest: **1785 passed**, 0 failed (36 skipped) |
| Frontend unit tests | node:test + tsx: **2335 passed**, 0 failed |
| Playwright E2E | **370 passed**, 0 failed, 357 skipped (727 total) |
| TypeScript suppressions | **0** (`@ts-nocheck`, `@ts-ignore`, `@ts-expect-error`) |
| ESLint-disable pragmas in source | **0** |
| Explicit unsafe `any` escapes | **0** (`: any`, `as any`, `as unknown as`) |

`strict` and `noImplicitAny` are enabled in the primary `backend/tsconfig.json` and
`frontend/tsconfig.json`, so the ordinary `typecheck` script and CI enforce strict mode. The
retained `tsconfig.strict.json` files extend those primary configurations without weakening or
overriding them.

Dynamic SQL rows use `Record<string, unknown>` and callers declare or narrow the columns they
consume. External and parsed data stays `unknown` until a local guard validates it.

## Tooling and CI

- Backend builds from TypeScript with `tsc -p tsconfig.build.json` and runs `dist/index.js`.
- Frontend builds from TypeScript with Vite.
- The primary CI workflow runs strict typecheck for both projects before lint, tests and builds.
- The real-app Playwright workflow executes TypeScript backend sources through `tsx` and refers to
  the migrated `.ts` E2E files.
- CommonJS files under `frontend/packages/` remain intentionally outside the TypeScript source
  trees as packaging and native-shell entry points.

## Verification commands

```bash
cd backend  && npm run typecheck && npm run typecheck:strict && npm run build && npm test && npm run lint
cd frontend && npm run typecheck && npm run typecheck:strict && npm run build && npm test && npm run lint
cd frontend && npm run test:e2e
```
