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

## Gmail-style new-mail notifications on Android

- **Why:** a new-mail notification could show a generic, hardcoded-English card
  ("New mail" / "You have new mail." / "N new messages") on a phone set to Polish
  or any other language, without the sender or the subject — even though the
  server knows both. The background reconciliation and native push paths looked
  up field names the native API never sends (`from_name` instead of `title`), so
  they always fell through to the hardcoded English fallbacks.
- **Fix:** all three Android notification paths (live WebSocket service, native
  push fetch worker, background reconciliation worker) now build the
  notification through one shared helper: the sender as the title, the subject
  plus a short preview of the body as the text — the Gmail layout. Every
  fallback line is localized on the device (app language preference, 9
  languages) instead of being hardcoded English.
- **Server:** the notification API (`/api/push/native/*`) gained a `snippet`
  field with a short preview of the body and stopped forcing English
  placeholder fallbacks (`title`/`body` are `null` when unknown, so the device
  localizes); the in-app frontend notification shows the same subject +
  preview text.
- **Testing:** JVM unit tests cover the helper across the three message shapes
  (native endpoint, legacy cookie list, live WebSocket) plus the localized
  fallbacks and the count template; backend route tests cover the `snippet`
  field and the absence of English placeholders; a frontend contract test
  pins the subject + snippet notification body.

For the current stable release, see [Release notes 4.4.1](Release-notes-4.4.1.md). Older
versions are listed in [Archive](Archive.md).
