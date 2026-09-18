# Release notes 4.0.4

**Status:** released 2026-09-18 · **Previous version:** 4.0.3 · **Type:** patch

## What this release is

4.0.4 is a **desktop-app release**. It brings the Electron build up to the same reliability and
control level as the web app: an integrated title bar, in-app control of the native
notifications, application-level Back / Forward, and the ability to make Inboxora the default
email app on Windows.

There are **no backend, database, API or configuration changes**: no backend source file changed
after 4.0.3 (the release commit touches only the package version metadata), no migration was
added, and the web/PWA build and the Android build behave exactly as in 4.0.3 — the desktop chrome is only rendered when the app runs inside the Electron shell. The
upgrade is a plain image/installer replacement: nothing to apply, nothing to reconfigure, and no
rollback procedure beyond the usual one.

## Title bar and window

- The desktop window uses Electron's `titleBarStyle: 'hidden'` with the Window Controls Overlay
  instead of the OS frame, so Inboxora's own bar reaches the top edge while minimize / maximize /
  close and close-to-tray stay native. The bar carries Back, Forward, Search (the existing
  Inboxora search engine, also on `Ctrl+E` / `Cmd+E`) and Settings, and its colours follow the
  active Inboxora theme without a restart. `contextIsolation`, `nodeIntegration: false` and
  `sandbox: true` are unchanged.
- On Windows and Linux the visible `File / Edit / View / Window / Help` menu bar is gone. Its
  accelerators are re-registered on the window — `Ctrl+R`, `F11`, `Ctrl+W` (still hide-to-tray),
  `Ctrl+M`, `Ctrl+,` — and the tray keeps New Mail, Sync, Show/Hide, Change Host and Quit. macOS
  keeps its system application menu.
- Settings opens as an overlay below the bar, so Back / Forward / Search stay reachable while it
  is open.

## Back and Forward walk Inboxora's views

`webContents.navigationHistory` only ever contained real document loads (login, OIDC), because
Inboxora navigates by swapping application state. Back / Forward therefore use a bounded
application view history — mail → message → Calendar → Contacts → Settings, including the
selected account, folder and open message. A restored message is resolved by its exact row id
first and, only when that row is gone, by its durable reference (the RFC `Message-ID` scoped to
its account, else the row id), then parked where the reading pane can find it. So Back returns
the exact copy that was being read — the same Message-ID can exist in INBOX and Archive, and the
durable lookup prefers the INBOX one — and still finds the message after a move or re-sync
replaced its physical row.

## Native notifications

- Desktop notifications are controlled by Inboxora instead of being unconditional. The preference
  lives in **Settings → Notifications → System notifications**, is stored locally per
  installation in the Electron config under `app.getPath('userData')`, and never syncs as an
  account setting. The Electron main process reads it before showing anything, so turning
  notifications off blocks them on every path.
- The card reports what the operating system actually reported. *Send test notification* goes
  renderer → preload → IPC → Electron `Notification` and distinguishes a confirmed delivery
  (Electron's `show`), "sent but not confirmed" (no event arrived), and the failure the OS
  returned, so a toast Windows silently drops is visible instead of reported as success. On
  Windows the OS state is read from the notification registry; elsewhere it is reported as
  unknown and the card says "enabled in Inboxora" rather than claiming more. The state is
  re-read when the window regains focus, and the system settings shortcut is always offered where
  the platform has one.

## Default email app on Windows

- Inboxora registers itself as an email client and `mailto:` handler (the `Inboxora.mailto`
  ProgID plus the `RegisteredApplications`/capabilities entries, and `ApplicationIcon`), so it is
  listed under **Settings → Default apps** for Email and for the `mailto:` link type. The
  installer and the app both write it, and both tell the shell the associations changed
  (`SHChangeNotify(SHCNE_ASSOCCHANGED)` with `SHCNF_FLUSH`); the in-app re-registration waits for
  that notification (bounded) so the Default apps page opened right after it already shows the
  new state.
- **Settings → Notifications → Default email app** reports whether Inboxora is the current
  handler, re-asserts the registration, and opens the Windows default-apps page — the per-app
  page on Windows 11, the general list on Windows 10. Windows 10/11 do not let an application
  make itself the default, and the card says so: the user confirms the choice in Settings.
- "Registered" means a *complete* registration (the `mailto` association, the
  `RegisteredApplications` entry and the launch command). A half-written one is reported as not
  registered and can be repaired from the card — not even a `UserChoice` pointing at Inboxora
  makes a handler that cannot launch look like a working default.
- The app no longer writes Electron's legacy `HKCU\Software\Classes\mailto` handler, so merely
  launching Inboxora offers it as a choice instead of claiming the generic key; the installer
  removes such a legacy handler left by an earlier build, but only while the command is still
  Inboxora's own.

## No duplicate notifications

Inside the desktop shell the app no longer registers its service worker (it only ever served Web
Push) and no longer restores or creates a Web Push subscription; an existing subscription left by
an earlier desktop build is unsubscribed and unregistered on first run. Web Push remains the
browser/PWA path, unchanged. A single message can no longer produce two operating-system
notifications.

## Known safe limitations

- The desktop UI still needs one manual pass on real hardware: Window Controls Overlay visuals,
  window dragging, Windows display scaling (100 / 125 / 150 %) and the real OS toast — including
  the case where Windows has notifications switched off for Inboxora. Automated coverage stops at
  the main-process logic (with a stubbed Electron, registry and shell) and the renderer helpers;
  the checklist is in [Notifications](Notifications.md). This is why the desktop artifacts are
  published for evaluation rather than declared production-ready.
- The per-app Default apps page is used from Windows 11 build 22000 up. On an installation without
  the April 2023 cumulative update the parameter is ignored and the general Default apps list
  opens instead — a graceful fallback, not an error.
- Notifications require the Electron process to be running (window open, minimized or hidden in
  the tray). After **Quit** nothing can arrive; that would need a WNS/APNs/background service and
  is out of scope.
- `mailto:` links are handled while Inboxora runs; the Default apps choice itself is confirmed by
  the user in Windows Settings, as Windows requires.

## Verification

- Frontend: `tsc --noEmit` clean, `eslint src --max-warnings 0` clean, production build passes,
  full suite 2492 tests green, i18n parity for all nine locales green (1747 checks). New/updated
  suites: application view history (pure rules plus restore driven through the real store
  actions), the desktop Web Push migration, desktop shell detection and title-bar theme parsing,
  the Electron notification preference/overlay-theme/platform policy and Windows registry
  parsing, and the Windows mail-handler state, health and shell-notification contract.
- The Electron main process was additionally exercised end to end with a stubbed Electron,
  registry and shell: menu removal, overlay theme, notification gating and test outcomes, the
  notification registry state on Windows, the mail-handler state transitions
  (`registered` → `default` → `not-registered`), the exact `reg add` writes, the awaited
  `SHChangeNotify(0x08000000, 0x1000)`, and the Windows 10 vs 11 settings URIs.
- CI: `Backend` and `Frontend` both green (typecheck, lint, build, tests, audit).
- Backend: no source, schema or migration change since 4.0.3, so its suite and the migration
  integrity checks were not re-run for this release; `tsc --noEmit` and `eslint` were re-run after
  the version metadata bump and are clean.

See [`docs/CHANGELOG.md`](../CHANGELOG.md) for the concise release record.
