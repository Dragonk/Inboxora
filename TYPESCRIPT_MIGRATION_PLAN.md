# TypeScript Migration Plan for Inboxora (dev branch)

## Status: IN PROGRESS
## Started: 2026-09-12

---

## Project Summary

| | Backend | Frontend |
|---|---|---|
| **Source files** | 299 `.js` | 236 `.js`/`.jsx` |
| **Lines of code (src/)** | ~58,255 | ~52,052 |
| **Test files** | 144 | 90 |
| **JSDoc annotations** | 0 files | 1 file |
| **Module system** | ESM (`"type":"module"`) | ESM + Vite |
| **Largest file** | `imapManager.js` (5,582 LOC) | `AdminPanel.jsx` (8,925 LOC) |
| **TypeScript** | ❌ none | ❌ none |

---

## Phase 0 — Tooling & Configuration

- [ ] 0a. Install TypeScript dev dependencies (backend + frontend)
- [ ] 0b. Create `backend/tsconfig.json`
- [ ] 0c. Create `frontend/tsconfig.json`
- [ ] 0d. Update `package.json` scripts (typecheck)
- [ ] 0e. Update ESLint configs for TypeScript
- [ ] 0f. Verify baseline: `tsc --noEmit` runs with allowJs

## Phase 1 — Backend Migration (299 files)

- [ ] 1a. Convert `src/utils/` (31 files)
- [ ] 1b. Convert `src/services/` core infra
- [ ] 1c. Convert `src/services/` helpers
- [ ] 1d. Convert `src/services/` domain
- [ ] 1e. Convert `src/services/` schedulers
- [ ] 1f. Convert `src/middleware/` (5 files)
- [ ] 1g. Convert `src/routes/` (65 files)
- [ ] 1h. Convert `src/plugins/` (33 files)
- [ ] 1i. Convert `src/scripts/` (6 files)
- [ ] 1j. Convert `index.js` → `index.ts`
- [ ] 1k. Migrate backend tests (vitest, 144 files)
- [ ] 1l. Create `src/types/`

## Phase 2 — Frontend Migration (236 files)

- [ ] 2a. Convert `src/utils/`
- [ ] 2b. Convert `src/store/` (6 files)
- [ ] 2c. Convert `src/hooks/` (10 files)
- [ ] 2d. Convert `src/plugins/` UI (11 files)
- [ ] 2e. Convert `src/components/` small → medium → large
- [ ] 2f. Convert root files
- [ ] 2g. Migrate frontend tests (90 files)
- [ ] 2h. Create `src/types/`

## Phase 3 — Frontend Packages

- [ ] 3a. Convert `packages/electron/`
- [ ] 3b. Convert `packages/scripts/`

## Phase 4 — E2E & CI

- [ ] 4a. Convert Playwright config + specs
- [ ] 4b. Verify Docker builds
- [ ] 4c. Add typecheck to CI

## Phase 5 — Type Cleanup

- [ ] 5a. Count `: any` baseline
- [ ] 5b. Remove `any` types
- [ ] 5c. Enable `strict: true`
- [ ] 5d. Remove `@ts-ignore`
- [ ] 5e. Final verification

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `imapManager.js` 5,582 LOC | Split into sessions, temporary `@ts-nocheck` |
| `AdminPanel.jsx` 8,925 LOC | Leave for last, consider refactoring |
| `@types/*` incomplete | Custom `*.d.ts` declarations |
| Zustand v4 weak types | Consider v5 upgrade or wrapper |
| Electron + TS | Verify electron-builder v26 support |
| `node --test` lacks TS | Add `tsx` loader |
| Import extensions with NodeNext | Keep `.js` in imports (TS resolves) |
