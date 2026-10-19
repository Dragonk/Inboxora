# Development changes — unreleased

These changes are on the development branch and ship with the next release. For the
current stable release, see [Release notes 4.3.7](Release-notes-4.3.7.md). Older
versions are listed in [Archive](Archive.md).

## Fixed

- **Phone-width reminder settings.** The calendar reminder lead-time chips wrap
  instead of shrinking into unreadable slivers, the lead/mode pair stacks on phones,
  upcoming reminder rows wrap with a compact date, and delivery-warning rows let their
  fix buttons flow to the next line.
- **Android notifications after a reboot.** The boot receiver now creates the
  notification channels before starting the live push foreground service and the
  reminder sync - until the app was opened at least once after a reboot, new-mail
  and reminder notifications posted to not-yet-existing channels and dropped.

## Validation

- Frontend: `npm run typecheck`, `npm run lint`, full test suite, `npm run build`
  passed.
- Android: `:app:compileDebugJavaWithJavac`, `:app:testDebugUnitTest` passed.
