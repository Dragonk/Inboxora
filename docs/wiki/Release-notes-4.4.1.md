# Inboxora 4.4.1

Released **2026-10-20**.

[Downloads](https://github.com/Dragonk/Inboxora/releases/tag/v4.4.1) -
[Changelog](https://github.com/Dragonk/Inboxora/blob/v4.4.1/docs/CHANGELOG.md) -
[Upgrading](Upgrading.md#upgrading-to-441)

Inboxora 4.4.1 is a hotfix for 4.4.0: pinch zoom works again in the message
view on the Android app.

## Fixed

- **Pinch zoom in the message view on Android.** The Gmail-style shrink-to-fit
  introduced in 4.4.0 re-derived its scale on every layout pass. Pinch zooming
  the Android WebView reflows the layout - the frame's CSS-pixel width shrinks
  while fixed-width content keeps its size - so the pass ran mid-gesture and
  scaled the body right back down to the shrunk viewport: the zoom appeared to
  do nothing. The fit now keeps the recorded state while the viewport shrinks
  over unchanged content, including repeated layout passes at the same zoom
  level, so the zoomed message pans inside the frame - the same horizontal
  scrolling as before 4.4.0. Zooming out, rotating the device, widening the
  reading pane or any change of the content itself (image loads, quote folding)
  re-derives the fit as before.

## Known safe limitations

- A reading pane that narrows while its content is unchanged (a side panel
  opening, rotation to portrait) keeps the previously fitted scale until the
  content or the viewport changes again; the message pans horizontally inside
  the frame, exactly as before 4.4.0.
- Document-layout previews (e.g. docx attachments) remain excluded from the
  fit and keep their natural width and their own scrolling.
- Message frames stay sandboxed without allow-scripts: the fix runs inside
  the parent document and never executes message code.

## Upgrade requirements

No database migration, no new environment variable and no compose change: the
standard upgrade steps apply. Deploy matching backend and frontend **4.4.1**
images or install the updated desktop/Android apps. Android 4.4.1 uses
`versionCode 4040100`; update the APK so its bundled web build keeps pinch
zoom working. See [Upgrading](Upgrading.md#upgrading-to-441).

## Validation

- Frontend: `npm run typecheck`, `npm run lint` with zero warnings, the full
  test suite (3952 tests) and `npm run build` passed locally and in CI.
- E2E: the Playwright pinch-zoom regressions passed on the mobile project - a
  synthesized pinch over a fitted email and a layout-viewport shrink reproducing
  the Android WebView reflow; the desktop project skips the touch-only specs.
- Backend: unchanged in this release (version bump only); the CI suite passed.
- Android: `:app:compileDebugJavaWithJavac` passed after the version bump.

