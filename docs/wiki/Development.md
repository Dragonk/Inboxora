# Development

Run relevant unit tests, lint and production builds in both frontend and backend. Run Playwright locally without Docker where available. Review the final diff and update Wiki source in `docs/wiki/` for every user-visible behavior or configuration change.

The README is intentionally concise; this Wiki is the product and operational knowledge base.

## V3 interface validation

The V3 default uses Ink, self-hosted DM Sans/Fraunces/JetBrains Mono and the comfortable list. Existing theme, font, scale and width preferences are not migrated or reset. Shared controls live in `ui.jsx`/`ui.css`; calendar and contacts have scoped presentation styles. Email HTML continues to use its existing isolated renderer.

Use Node 22 and `npm ci`. Run frontend unit tests, lint and build, then `npm run test:e2e` with Chromium installed. The default Playwright run excludes the live-backend spec; run it separately with `PLAYWRIGHT_REAL_APP=1` and the provisioned backend described by its workflow.

`v3-interface.spec.js` checks both functionality and image references at desktop, tablet and mobile sizes. Fixtures freeze date/time and locale, use synthetic data and wait for self-hosted fonts. Review image changes against `V3-Inboxora.html` before updating references with `npx playwright test e2e/v3-interface.spec.js --update-snapshots`. CI never updates references and uploads diffs and traces on failure. Browser gates run for PRs to both `dev` and `main`.

See [V3 interface](V3-interface.md) for the feature mapping and regression coverage.
