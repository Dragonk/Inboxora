import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Inboxora branding is used by user-visible application surfaces", async () => {
  const checks = [
    ["frontend/src/components/MailApp.jsx", "document.title = 'Inboxora'"],
    ["frontend/src/components/AdminPanel.jsx", "fromName: 'Inboxora'"],
    ["frontend/src/components/ElectronNotificationBridge.jsx", "Inboxora downloaded"],
    ["frontend/src/components/TodoistTaskModal.jsx", "View in Inboxora"],
    ["frontend/public/sw.js", "title       = 'Inboxora'"],
  ];
  for (const [file, expected] of checks) {
    const content = await source(file);
    assert.ok(content.includes(expected), `missing Inboxora branding in ${file}`);
    assert.ok(!content.includes("cfg.fromName || 'MailFlow'"), `legacy system-email fallback in ${file}`);
  }
});

test("Inboxora wordmark and versioned PWA assets replace legacy MailFlow branding", async () => {
  const [readme, sidebar, login, logo, app, index, manifest, worker, themes, admin, store, socket, mailApp] = await Promise.all([
    source("README.md"),
    source("frontend/src/components/Sidebar.jsx"),
    source("frontend/src/components/LoginPage.jsx"),
    source("frontend/src/components/LogoMark.jsx"),
    source("frontend/src/App.jsx"),
    source("frontend/index.html"),
    source("frontend/public/manifest.json"),
    source("frontend/public/sw.js"),
    source("frontend/src/themes.js"),
    source("frontend/src/components/AdminPanel.jsx"),
    source("frontend/src/store/index.js"),
    source("frontend/src/hooks/useWebSocket.js"),
    source("frontend/src/components/MailApp.jsx"),
  ]);

  for (const content of [sidebar, login]) {
    assert.match(content, /Inboxora/, "application chrome must show the Inboxora wordmark");
    assert.doesNotMatch(content, />\s*Mail\s*</, "application chrome must not retain the MailFlow wordmark");
  }
  assert.match(readme, /media\/inboxora-logo\.png/, "the GitHub README must present the current Inboxora app icon");
  assert.doesNotMatch(logo, /MailFlow/, "shared logo component must be branded Inboxora");
  assert.match(logo, /inboxora-logo-mark__light/, "shared logo component must render the high-contrast mark for light interfaces");
  assert.match(logo, /inboxora-logo-mark__dark/, "shared logo component must render the high-contrast mark for dark interfaces");
  assert.match(logo, /\/inboxora-ui-logo-dark\.png\?v=inboxora-2/, "shared logo component must use the light-on-dark Inboxora UI asset");
  assert.match(logo, /\/inboxora-ui-logo-light\.png\?v=inboxora-2/, "shared logo component must use the dark-on-light Inboxora UI asset");
  assert.doesNotMatch(logo, /inboxora-mark\.svg/, "shared logo component must not use the deprecated hexagon mark");
  assert.doesNotMatch(logo, /inboxora-icon-512\.png/, "shared logo component must not use the black-background PWA icon");
  assert.match(index, /manifest\.json\?v=inboxora-2/, "the updated manifest must bypass legacy PWA metadata caches");
  assert.match(app, /sw\.js\?v=inboxora-2/, "the updated service worker must replace legacy registrations");
  assert.match(index, /rel="icon" type="image\/png" href="\/inboxora-icon-512\.png\?v=inboxora-2"/, "the browser favicon must use the rounded Inboxora PNG");
  assert.doesNotMatch(index, /inboxora-mark\.svg/, "the transparent UI logo must not replace the browser favicon");
  assert.doesNotMatch(themes, /buildFaviconSvg|_setFaviconLink|_rasterise/, "runtime theming must not replace the black-background PNG favicon");
  assert.match(worker, /icon:\s*'\/inboxora-icon-512\.png\?v=inboxora-2'/, "push notifications must use the fixed Inboxora icon");
  assert.doesNotMatch(worker, /icon\s*=\s*'\/inboxora-icon-512\.png'/, "push payload data must not override the notification icon");
  assert.doesNotMatch(manifest, /inboxora-icon-(?!512)/, "the manifest must use one canonical Inboxora icon asset");
  assert.match(manifest, /"purpose": "any"/, "the detailed app icon must not claim the maskable safe zone");
  assert.match(themes, /data-inboxora-surface/, "the active application surface must select the matching logo contrast variant");
  assert.match(themes, /var\(--bg-primary\)/, "the logo contrast variant must resolve custom application surface colors");
  assert.match(themes, /slice\(0, 3\)/, "the logo contrast variant must support rgba custom surface colors");
  for (const content of [admin, store, socket, themes, mailApp]) {
    assert.doesNotMatch(content, /[Ff]aviconBadge|updateFaviconBadge/, "a fixed favicon must not expose an ineffective badge preference");
  }
  for (const content of [index, manifest, worker]) {
    assert.match(content, /inboxora-icon-512\.png\?v=inboxora-2/, "PWA metadata must reference a cache-busting Inboxora icon");
    assert.doesNotMatch(content, /["']\/icon-512\.png/, "PWA metadata must not retain the legacy icon URL");
  }
  await Promise.all([
    access(new URL("../../media/inboxora-logo.png", import.meta.url)),
    access(new URL("../public/inboxora-ui-logo-light.png", import.meta.url)),
    access(new URL("../public/inboxora-ui-logo-dark.png", import.meta.url)),
    access(new URL("../public/inboxora-icon-512.png", import.meta.url)),
    access(new URL("../packages/electron/icons/icon.png", import.meta.url)),
    access(new URL("../packages/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png", import.meta.url)),
  ]);
});

test("legacy technical identifiers have an explicit compatibility record", async () => {
  const audit = await source("docs/technical-identifier-audit.md");
  for (const identifier of [
    "mailflow_",
    "mailflow-nav",
    "X-MailFlow-Image-Opt-In",
    "data-mailflow-",
    "application/x-mailflow-",
    "MAILFLOW_",
    "mailflow Docker network",
  ]) {
    assert.ok(audit.replace(/`/g, "").includes(identifier), `missing documented exception: ${identifier}`);
  }
});
