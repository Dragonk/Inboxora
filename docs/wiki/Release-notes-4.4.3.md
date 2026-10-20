# Inboxora 4.4.3

Released **2026-10-20**.

[Downloads](https://github.com/Dragonk/Inboxora/releases/tag/v4.4.3) -
[Changelog](https://github.com/Dragonk/Inboxora/blob/v4.4.3/docs/CHANGELOG.md) -
[Upgrading](Upgrading.md#upgrading-to-443)

Inboxora 4.4.3 completes one-finger panning of the pinch-zoomed message view on
Android: after 4.4.2 unlocked the vertical axis, horizontal drags were still claimed by
the application's own swipe gestures.

## Fixed

- **Horizontal panning of the pinch-zoomed view with one finger.** While zoomed in, a
  one-finger drag moved the zoomed message view vertically only. The mobile swipe surfaces
  (list rows, drawer, pane edge, floating-window drag zones) carry an inline
  `touch-action: pan-y pinch-zoom`, which reserves horizontal drags for their JavaScript
  gestures - and the pane edge swipe-back consumed exactly such drags with
  `preventDefault()` before the compositor could pan. While the visual viewport is zoomed
  the new `html.zoomed-viewport` stylesheet rule relaxes those surfaces to
  `touch-action: auto !important`, and every mobile horizontal gesture now stands down
  through a shared zoomed-viewport gate before it can claim a drag, so a one-finger drag
  pans the zoomed view in both axes. At rest the swipe gestures, their touch-action
  reservations and the overscroll protection apply again unchanged.

## Known safe limitations

- Panning of the zoomed view over a scrollable surface still scrolls that surface first;
  the relaxed touch-action only hands a one-finger drag over to the zoomed viewport where
  the swipe surfaces would otherwise claim it.
- On some vendor WebView builds (e.g. MIUI/HyperOS) the system zoom gesture may still use
  its own two-finger pan; the standard Chromium visual-viewport pan with one finger applies
  where the WebView implements it.

## Upgrade requirements

No database migration, no new environment variable and no compose change: the standard
upgrade steps apply. Deploy matching backend and frontend **4.4.3** images or install the
updated desktop/Android apps. Android 4.4.3 uses `versionCode 4040300`; update the APK so
its bundled web build pans the pinch-zoomed message view horizontally with one finger.
See [Upgrading](Upgrading.md#upgrading-to-443).

## Validation

- Frontend: `npm run typecheck`, lint, the full test suite and `npm run build` passed in CI.
- E2E: the Playwright pinch-zoom spec gained a mobile-only regression that pinches over the
  message body itself, asserts the swipe rows' computed `touch-action` flips from
  `pan-y pinch-zoom` to `auto` while zoomed, pans sideways with one finger, verifies the
  visual viewport moved horizontally and that the pane was not swiped away, then confirms
  the reservations return after zooming out; all browser shards passed.
- Contract tests pin the three-layer fix: the stylesheet override beats the swipe surfaces'
  inline touch-action, the gesture-arbiter gate stands the horizontal claimants down before
  their `preventDefault`, and the `zoomed-viewport` class toggles together with the
  overscroll release.
