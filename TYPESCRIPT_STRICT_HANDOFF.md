# Inboxora — strict TypeScript migration completed

The `dev` branch now uses strict TypeScript as its primary configuration.

## Verified completion criteria

- `backend/tsconfig.json` and `frontend/tsconfig.json` both enable `strict` and
  `noImplicitAny`.
- `npm run typecheck` and `npm run typecheck:strict` report **0 errors** in both projects.
- Source trees contain no `.js`/`.jsx` implementation files.
- Source contains 0 TypeScript suppression pragmas, 0 ESLint-disable pragmas and 0 explicit
  unsafe `any` escapes.
- Dynamic rows and external payloads are represented as `unknown` and narrowed through declared
  contracts instead of being silenced with casts.
- CI invokes strict typechecking before lint, tests and builds. The real-app Playwright workflow
  invokes migrated TypeScript backend and E2E sources correctly.

## Maintenance rules

1. Keep strict mode enabled in the primary `tsconfig.json` files; do not reintroduce opt-in-only
   strict checking.
2. Do not add `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, ESLint-disable pragmas, explicit
   `any`, `as any`, or double assertions.
3. Represent untrusted inputs with `unknown`, then validate and narrow at the boundary.
4. Run the verification commands before pushing:

   ```bash
   cd backend  && npm run typecheck && npm run typecheck:strict && npm run build && npm test && npm run lint
   cd frontend && npm run typecheck && npm run typecheck:strict && npm run build && npm test && npm run lint
   cd frontend && npm run test:e2e
   ```

For the release summary and configuration details, see `TYPESCRIPT_MIGRATION_STATUS.md` and
`docs/wiki/Release-notes-4.0.1.md`.
