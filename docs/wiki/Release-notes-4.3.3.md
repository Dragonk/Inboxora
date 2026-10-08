# Inboxora 4.3.3

Released **2026-10-08**.

[Downloads](https://github.com/Dragonk/Inboxora/releases/tag/v4.3.3) ·
[Changelog](https://github.com/Dragonk/Inboxora/blob/v4.3.3/docs/CHANGELOG.md) ·
[Upgrading](Upgrading.md#upgrading-to-433)

Inboxora 4.3.3 is a hotfix release addressing system status bar and display cutout overlap on Android 15+ edge-to-edge screens and mobile WebViews.

## Fixed

- **Android status bar and display cutout insets.** On Android 15 (API level 35) and devices where the application targets SDK 35 or higher (Inboxora targets SDK 36), edge-to-edge layout is enforced at the platform level. On affected devices, the web view extended under the status bar, causing top-bar buttons (menu, search, compose) to render directly behind system clock, Wi-Fi and battery indicators. Native `MainActivity` now applies window insets padding to the root content view for `statusBars()` and `displayCutout()` and consumes the handled insets so child views and the WebView do not apply duplicate top safe-area insets, keeping content cleanly below the status bar while preserving standard IME/keyboard resize behavior.
- **Mobile top bar safe-area padding.** Updated `MobileTopBar` top padding to respect `calc(4px + var(--sat))` when navigation is positioned at the top of the screen.
- **Bottom navigation top container offset.** When mobile navigation is docked at the bottom of the screen, the top content container now applies `paddingTop: var(--sat)` so headers and lists do not collide with the system status bar or display cutout.

## Changed

- **Capacitor SystemBars insets configuration.** Configured `plugins.SystemBars.insetsHandling = "native"` in `capacitor.config.json` to handle system bars and gesture navigation bars natively without zeroing out view padding when `viewport-fit=cover` is present.
- **Safe-area custom property fallback.** CSS safe area variables (`--sat`, `--sab`, `--sal`, `--sar`) in `index.css` now fall back to Capacitor-injected custom properties (`--safe-area-inset-*`) with native `env()` fallback, guaranteeing consistent safe-area handling across native and mobile web environments.

## Database migration

None. This release contains frontend and native packaging updates only.

## Upgrade requirements

Deploy matching **4.3.3** backend and frontend images or update the native Android application. No database migrations are included in this release.

Use one of the immutable stable image tags:

- `ghcr.io/dragonk/inboxora-backend:4.3.3`
- `ghcr.io/dragonk/inboxora-frontend:4.3.3`

`v4.3.3` and `latest` point to the same multi-architecture AMD64/ARM64 manifests after release publication. Android 4.3.3 uses `versionCode 4030300`. Windows, Linux and Android artifacts are attached to the GitHub release after the signed native build completes.
