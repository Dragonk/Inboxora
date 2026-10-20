# Inboxora 4.4.2

Released **2026-10-20**.

[Downloads](https://github.com/Dragonk/Inboxora/releases/tag/v4.4.2) -
[Changelog](https://github.com/Dragonk/Inboxora/blob/v4.4.2/docs/CHANGELOG.md) -
[Upgrading](Upgrading.md#upgrading-to-442)

Inboxora 4.4.2 fixes the Android reading experience after a pinch zoom and
makes new-mail notifications read like Gmail's.

## Changed

- **Pinch zoom is now explicitly enabled in the Android WebView** (`android.zoomEnabled` in
  the Capacitor config). Capacitor disables WebView zoom by default, so most devices had no
  pinch zoom in the APK at all; the config now makes the intended behaviour explicit on
  every device.
- **New-mail notifications follow Gmail's layout.** The sender is the title and the subject
  plus a short preview of the body is the text, on every notification channel (live
  WebSocket, native push, background reconciliation, web push and the in-app toast).

## Fixed

- **One-finger panning of the pinch-zoomed message view on Android.** The app pins
  `overscroll-behavior: none` on the root scrollers so a browser cannot hijack row swipes
  into pull-to-refresh or history navigation; on some WebView builds that same lock also
  stopped the root scroller from handing a one-finger drag over to the pinch-zoomed visual
  viewport, so after pinching the view could only be panned with a two-finger drag. The lock
  is now released with an inline `overscroll-behavior: auto` while
  `visualViewport.scale > 1`, and the stylesheet value applies again unchanged at rest.
- **New-mail notifications were generic English.** Notifications arriving through native
  push or the background reconciliation worker showed a hardcoded-English card ("New mail" /
  "You have new mail.") on a phone set to any other language, without the sender or the
  subject, because those paths looked up field names the native API never sends. All three
  Android notification paths now build their text through one shared helper with localized
  (`native_new_mail*`) fallbacks, the notification API returns a `snippet` preview and stops
  forcing English placeholder fallbacks, and the live INBOX sync hydrates snippets for the
  alert candidates so the preview is present immediately.

## Known safe limitations

- Panning of the zoomed view over a scrollable surface still scrolls that surface first; the
  relaxed overscroll lock only hands a one-finger drag over to the zoomed viewport where the
  root scroller would otherwise swallow it.
- On some vendor WebView builds (e.g. MIUI/HyperOS) the system zoom gesture may still use
  its own two-finger pan; the standard Chromium visual-viewport pan with one finger applies
  where the WebView implements it.
- The notification preview needs a text or HTML part the server can fetch; a message whose
  body cannot be fetched (or a provider refusing the bounded re-fetch) notifies with the
  subject only.

## Upgrade requirements

No database migration, no new environment variable and no compose change: the standard
upgrade steps apply. Deploy matching backend and frontend **4.4.2** images or install the
updated desktop/Android apps. Android 4.4.2 uses `versionCode 4040200`; update the APK so
its bundled web build keeps one-finger panning and the localized notification content.
See [Upgrading](Upgrading.md#upgrading-to-442).

## Validation

- Frontend: `npm run typecheck`, `npm run lint` with zero warnings, the full test suite
  (3958 tests), the i18n suite (2699 tests) and `npm run build` passed locally and in CI.
- E2E: the Playwright pinch-zoom spec gained a mobile-only regression that pinches, asserts
  the relaxed overscroll lock, pans with one finger and verifies the lock returns after
  zooming out; all browser shards passed.
- Backend: typecheck, lint and the full vitest suite passed locally and in CI; the
  notification API tests cover the new `snippet` field and the absence of English
  placeholders.
- Android: `:app:compileDebugJavaWithJavac` and `:app:testDebugUnitTest` (including the new
  `InboxoraNotificationTextTest` suite) passed.
