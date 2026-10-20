# Development changes - unreleased

Changes on `dev` after **4.4.1**, not yet released.

## One-finger panning after pinch zoom in the Android app

- **Why:** after pinching to zoom into a message, the zoomed view could only be
  panned with a two-finger drag - a one-finger drag did nothing. The app pins
  `overscroll-behavior: none` on the root scrollers (`src/index.css`) so a
  browser cannot hijack row swipes into pull-to-refresh or history navigation;
  on some WebView builds that same lock also stops the root scroller from
  handing a one-finger drag over to the pinch-zoomed visual viewport.
- **Fix:** the lock is now relaxed with an inline `overscroll-behavior: auto`
  on `html` and `body` while `window.visualViewport.scale > 1`, and removed at
  rest so the stylesheet value - and its pull-to-refresh / history-swipe
  protection - applies unchanged at scale 1.
- **Pinch zoom is also now explicitly enabled in the APK**
  (`android.zoomEnabled` in the Capacitor config): Capacitor disables WebView
  zoom by default, so most devices had no pinch zoom in the app at all; the
  config now makes the intended behaviour explicit.
- **Testing:** unit tests cover the zoom detection and the override
  application/removal; the Playwright pinch-zoom spec gains a mobile-only
  regression that pinches, asserts the relaxed lock, pans with one finger and
  verifies the lock returns after zooming out.

For the current stable release, see [Release notes 4.4.1](Release-notes-4.4.1.md). Older
versions are listed in [Archive](Archive.md).
