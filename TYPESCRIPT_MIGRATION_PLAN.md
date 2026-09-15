# TypeScript migration plan — completed

The Inboxora source migration and strictness work are complete on `dev`.

## Completed work

- Backend source is TypeScript only; frontend source is TypeScript/TSX only.
- The primary TypeScript configurations enable `strict` and `noImplicitAny`.
- Both primary and strict-compatibility typecheck commands report 0 errors.
- Dynamic database rows and external payloads use `unknown`-based declared contracts and guards.
- Source contains no TypeScript suppression pragmas, ESLint-disable pragmas or explicit unsafe
  `any` escapes.
- The CI workflow executes strict typechecking before lint, tests and builds.
- Docker and real-app workflow entry points use the emitted or `tsx`-executed TypeScript paths.

## Ongoing maintenance

Keep strict checking in the primary configurations, type inputs from their real producer, and
narrow untrusted values at a declared boundary. Before pushing, run:

```bash
cd backend  && npm run typecheck && npm run typecheck:strict && npm run build && npm test && npm run lint
cd frontend && npm run typecheck && npm run typecheck:strict && npm run build && npm test && npm run lint
cd frontend && npm run test:e2e
```

Release-level evidence is maintained in `TYPESCRIPT_MIGRATION_STATUS.md`,
`docs/CHANGELOG.md`, and `docs/wiki/Release-notes-4.0.1.md`.
