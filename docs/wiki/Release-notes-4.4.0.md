# Inboxora 4.4.0

Released **2026-10-19**.

[Downloads](https://github.com/Dragonk/Inboxora/releases/tag/v4.4.0) -
[Changelog](https://github.com/Dragonk/Inboxora/blob/v4.4.0/docs/CHANGELOG.md) -
[Upgrading](Upgrading.md#upgrading-to-440)

Inboxora 4.4.0 is a mail-reading release: wide fixed-layout emails now fit the
phone without horizontal scrolling, and light-designed emails are re-themed for the
dark appearance the way Gmail renders them.

## Fixed

- **Wide emails on phone-sized screens.** A message body wider than its frame first
  reflows (fluid widths, wrapping, narrow-viewport table normalisation); whatever
  still overflows - legacy newsletters with hard-coded table widths - is scaled down
  to the frame width, so the whole message is visible with no horizontal scrolling.
  The scale never enlarges a message that already fits, is recomputed as images load,
  quotes fold or the pane resizes, and the auto-height measurement is scale-aware so a
  shrunken email leaves no empty space below it. Applies to every message view:
  reading pane, conversation reader, calendar descriptions and HTML attachment
  previews.
- **Light-designed emails in the dark appearance.** A message authored for a light
  page kept its glaring white cards in the dark theme, while Gmail re-themed the
  same messages to match the dark canvas. Inboxora now does the same: a light
  background (inline styles, background shorthands, legacy bgcolor attributes and
  the message's own <style> rules) is mirrored into the dark band with hue and
  relative depth preserved, and the dark text that would vanish on the new canvas is
  lifted to a readable light colour. A message that already ships a dark design keeps
  it, rules written for a dark scheme of the message's own are not double-inverted,
  and the light appearance adapts nothing.

## Known safe limitations

- Document-layout previews (e.g. docx attachments) intentionally keep their natural
  width and their own scrolling; they are not scaled to the frame.
- The dark re-theme rewrites the message colour declarations; images, background
  images and already-dark regions are left exactly as authored.
- Message frames stay sandboxed without allow-scripts: both adaptations run inside
  the existing sanitisation pass and never execute message code.

## Upgrade requirements

No database migration, no new environment variable and no compose change: the
standard upgrade steps apply. Deploy matching backend and frontend **4.4.0** images
or install the updated desktop/Android apps. Android 4.4.0 uses `versionCode
4040000`; update the APK so its bundled web build includes the mail-reading
improvements. See [Upgrading](Upgrading.md#upgrading-to-440).

## Validation

- Frontend: `npm run typecheck`, `npm run lint` with zero warnings, the full test
  suite (3946 tests), `npm run test:i18n` and `npm run build` passed in CI.
- E2E: the email-body Playwright suites (desktop and mobile) passed, including the
  new fit-to-width and dark-canvas re-theming specs.
- Backend: unchanged in this release (version bump only); the CI suite passed.
- Android: `:app:compileDebugJavaWithJavac` passed after the version bump.
