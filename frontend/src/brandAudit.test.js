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
  const [sidebar, login, logo, app, index, manifest, worker] = await Promise.all([
    source("frontend/src/components/Sidebar.jsx"),
    source("frontend/src/components/LoginPage.jsx"),
    source("frontend/src/components/LogoMark.jsx"),
    source("frontend/src/App.jsx"),
    source("frontend/index.html"),
    source("frontend/public/manifest.json"),
    source("frontend/public/sw.js"),
  ]);

  for (const content of [sidebar, login]) {
    assert.match(content, /Inboxora/, "application chrome must show the Inboxora wordmark");
    assert.doesNotMatch(content, />\s*Mail\s*</, "application chrome must not retain the MailFlow wordmark");
  }
  assert.doesNotMatch(logo, /MailFlow/, "shared logo component must be branded Inboxora");
  assert.match(index, /manifest\.json\?v=inboxora-1/, "the updated manifest must bypass legacy PWA metadata caches");
  assert.match(app, /sw\.js\?v=inboxora-1/, "the updated service worker must replace legacy registrations");
  for (const content of [index, manifest, worker]) {
    assert.match(content, /inboxora-icon-512\.png/, "PWA metadata must reference a cache-busting Inboxora icon");
    assert.doesNotMatch(content, /["']\/icon-512\.png/, "PWA metadata must not retain the legacy icon URL");
  }
  await Promise.all([
    access(new URL("../public/inboxora-icon-512.png", import.meta.url)),
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
