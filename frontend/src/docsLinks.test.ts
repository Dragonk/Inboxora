import assert from "node:assert/strict";
import test from "node:test";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * The documentation is part of the release, and it is large enough that a link into a renamed page, an
 * environment variable that no longer exists or an endpoint that was never implemented can sit unnoticed
 * for a long time. This suite audits the three things a reader follows: **local links** (including their
 * anchors), **environment variables** (against `.env.example`, the file an operator copies) and **API
 * routes** named in the provider, configuration and release documentation.
 *
 * It deliberately reads local files only — no network — so it runs on every CI job.
 */

const root = new URL("../../", import.meta.url);
const rootPath = root.pathname;

async function projectDocs(): Promise<string[]> {
  const fixed = [
    "README.md", "SECURITY.md", "CONTRIBUTING.md", "AGENTS.md", "ROADMAP.md",
    "docs/CHANGELOG.md", "docs/IMPLEMENTATION-STATUS.md", "docs/technical-identifier-audit.md",
    "backend/src/plugins/README.md",
  ];
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(join(rootPath, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".md")) found.push(path);
    }
  };
  await walk("docs");
  await walk(".github");
  return [...new Set([...fixed, ...found])];
}

/** The GitHub heading slug, near enough for the anchors this repository writes. */
const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");

function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) anchors.add(slug(heading[2]));
  }
  return anchors;
}

test("every local documentation link and anchor resolves", async () => {
  const docs = await projectDocs();
  const cache = new Map<string, string>();
  const read = async (path: string): Promise<string> => {
    if (!cache.has(path)) cache.set(path, await readFile(join(rootPath, path), "utf8"));
    return cache.get(path) as string;
  };

  const brokenLinks: string[] = [];
  const brokenAnchors: string[] = [];
  for (const doc of docs) {
    const text = await read(doc);
    // An inline code span is an example, not a link: a page may legitimately document link syntax.
    const prose = text.replace(/`[^`\n]*`/g, "");
    for (const match of prose.matchAll(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[2];
      if (/^(https?:|mailto:|tel:)/.test(target)) continue;
      if (target.startsWith("#")) {
        if (!anchorsOf(text).has(slug(target.slice(1)))) brokenAnchors.push(`${doc} -> ${target}`);
        continue;
      }
      const [pathPart, anchor] = target.split("#");
      const targetPath = resolve(dirname(join(rootPath, doc)), decodeURIComponent(pathPart));
      try {
        await access(targetPath);
      } catch {
        brokenLinks.push(`${doc} -> ${target}`);
        continue;
      }
      if (anchor && targetPath.endsWith(".md")) {
        const targetDocument = relative(rootPath, targetPath);
        const targetText = await read(targetDocument).catch(() => null);
        if (targetText && !anchorsOf(targetText).has(slug(anchor))) brokenAnchors.push(`${doc} -> ${target}`);
      }
    }
  }
  assert.deepEqual(brokenLinks, [], `broken local links:\n${brokenLinks.join("\n")}`);
  assert.deepEqual(brokenAnchors, [], `broken anchors:\n${brokenAnchors.join("\n")}`);
});

test("every documented runtime environment variable exists in .env.example", async () => {
  const envExample = await readFile(join(rootPath, ".env.example"), "utf8");
  // A token that starts like configuration but is not a variable name: a domain error code, or a
  // compose-level variable the compose file derives from a documented one.
  const notRuntimeConfiguration = (name: string): boolean =>
    name.endsWith("_TOO_LARGE")
    // A provider domain error code, quoted in the changelog because it is what the interface shows:
    // `PROVIDER_AUTH_REQUIRED` is a code, not a variable to set.
    || name === "PROVIDER_AUTH_REQUIRED"
    || name === "POSTGRES_DB";
  const prefixes = [
    "MAIL_", "MS_", "GOOGLE_", "PROVIDER_", "POSTGRES_", "DB_", "REDIS_", "APP_", "UPDATE_",
    "ENCRYPTION_", "SESSION_", "NTFY_", "VAPID_", "SMTP_", "IMAP_", "DAV_", "AI_", "OPENAI_",
    "OLLAMA_", "ANTHROPIC_", "LOG_", "TRUST_", "TZ", "NODE_",
  ];

  const missing: string[] = [];
  for (const doc of await projectDocs()) {
    const text = await readFile(join(rootPath, doc), "utf8");
    for (const match of text.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)) {
      const name = match[1];
      if (!prefixes.some(prefix => name.startsWith(prefix))) continue;
      if (notRuntimeConfiguration(name)) continue;
      if (!envExample.includes(name)) missing.push(`${doc}: ${name}`);
    }
  }
  assert.deepEqual([...new Set(missing)].sort(), [], `documented variables missing from .env.example:\n${missing.join("\n")}`);
});

test("every API route named in the release documentation exists in the backend", async () => {
  // Only the pages that name endpoints as instructions; a changelog entry may quote an old route.
  const pages = [
    "README.md", "docs/wiki/Provider-setup.md", "docs/wiki/Email-and-threading.md",
    "docs/wiki/Configuration.md", "docs/wiki/Contacts-and-DAV.md", "docs/wiki/Calendar.md",
    "docs/wiki/Upgrading.md", "docs/wiki/Troubleshooting.md",
    "docs/IMPLEMENTATION-STATUS.md", "docs/wiki/Release-notes-4.1.0.md",
  ];
  const backendSource = execFileSync(
    "bash",
    ["-lc", "cat $(find backend/src -name '*.ts' ! -name '*.test.ts')"],
    { cwd: rootPath, maxBuffer: 64 * 1024 * 1024 },
  ).toString();

  const missing: string[] = [];
  for (const page of pages) {
    const text = await readFile(join(rootPath, page), "utf8");
    for (const match of text.matchAll(/`(\/api\/[A-Za-z0-9/_:.$-]+)`/g)) {
      const route = match[1];
      const parts = route.split("?")[0].split("/").filter(Boolean);
      // The router prefix is what identifies the surface: `/api/mail/send` is registered on `/api/mail`.
      const prefix = `/${parts.slice(0, 2).join("/")}`;
      if (!backendSource.includes(prefix)) missing.push(`${page}: ${route}`);
    }
  }
  assert.deepEqual([...new Set(missing)].sort(), [], `documented routes with no backend surface:\n${missing.join("\n")}`);
});
