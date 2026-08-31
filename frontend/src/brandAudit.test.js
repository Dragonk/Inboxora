import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

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
