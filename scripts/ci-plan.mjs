import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CHECKS = [
  'run_backend',
  'run_backend_database',
  'run_frontend',
  'run_browser_e2e',
  'run_postgres_e2e',
  'run_real_app_e2e',
  'run_docs_screenshots',
  'run_push_stack',
];

function emptySelection(value = false) {
  return Object.fromEntries(CHECKS.map(name => [name, value]));
}

// An allowlist, not a list of known source extensions. A new build/config/input
// file must run validation by default. Test fixtures under docs/ are not prose.
export function isDocumentation(path) {
  return /^[^/]+\.md$/.test(path)
    || /^docs\/.*\.md$/.test(path)
    || /^\.github\/(?:ISSUE_TEMPLATE\/[^/]+\.md|PULL_REQUEST_TEMPLATE\.md)$/.test(path);
}

function isTestPath(path) {
  return /(?:^|\/)(?:__tests__\/.*|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?)$/.test(path);
}

function isIntegrationTest(path) {
  return /\.(?:integration|itest)\.test\.[cm]?[jt]sx?$/.test(path)
    || /(?:Postgres|Performance|Migration).*\.(?:test|integration)\.[cm]?[jt]sx?$/.test(path);
}

function isFrontendProduction(path) {
  if (!path.startsWith('frontend/')) return false;
  if (isTestPath(path)) return false;
  if (/^frontend\/(?:e2e|artifacts|playwright-report)\//.test(path)) return false;
  return /^frontend\/(?:src\/|index\.html$|vite\.config\.|package(?:-lock)?\.json$|nginx\.conf$)/.test(path);
}

function isBackendProduction(path) {
  if (!path.startsWith('backend/')) return false;
  if (isTestPath(path) || isIntegrationTest(path)) return false;
  return /^backend\/(?:src\/|migrations\/|package(?:-lock)?\.json$|tsconfig|vitest|eslint)/.test(path);
}

function isConversationDatabasePath(path) {
  return /^backend\/migrations\//.test(path)
    || /^backend\/src\/(?:services|routes|scripts)\/(?:conversation|logical|mailThread|messageFolder|mailFlag|providerSchema|upgrade|storageUpgrade)/i.test(path)
    || /^backend\/src\/services\/(?:db|migrations)\.[cm]?[jt]s$/.test(path)
    || /conversation.*\.(?:integration\.)?test\.[cm]?[jt]sx?$/i.test(path);
}

function isPushStackPath(path) {
  return /^(?:docker-compose(?:\.ghcr)?\.yml|frontend\/nginx\.conf|scripts\/push-integration-test\.mjs)$/.test(path)
    || /^backend\/src\/(?:routes|services)\/.*(?:push|ntfy|unifiedpush)/i.test(path)
    || /^frontend\/src\/.*(?:push|ntfy|unifiedpush)/i.test(path);
}

function isDocsScreenshotPath(path) {
  return /^media\/screenshots\//.test(path)
    || /^scripts\/(?:verify|compare)-docs-screenshots\.mjs$/.test(path)
    || /^frontend\/e2e\/docs-screenshots\./.test(path)
    || (isFrontendProduction(path) && /^frontend\/src\/(?:components|styles|locales|fonts|theme|App|main|index)/.test(path));
}

function isCiInfrastructure(path) {
  return /^\.github\/(?:workflows|actions)\//.test(path)
    || /^scripts\/ci-plan(?:\.test)?\.mjs$/.test(path);
}

function describeSelection(selection) {
  const selected = CHECKS.filter(name => selection[name]).map(name => name.replace(/^run_/, '').replaceAll('_', ' '));
  return selected.length ? `Selected: ${selected.join(', ')}.` : 'No runtime validation selected.';
}

export function classifyChanges(paths, eventName) {
  if (eventName === 'workflow_dispatch') {
    const selection = emptySelection(true);
    return { ...selection, run_tests: true, docs_only: false, reason: 'Manual validation runs every check.' };
  }
  if (!['push', 'pull_request'].includes(eventName)) {
    const selection = emptySelection(true);
    return { ...selection, run_tests: true, docs_only: false, reason: 'Unknown event: full validation.' };
  }
  if (!paths.length) {
    const selection = emptySelection(true);
    return { ...selection, run_tests: true, docs_only: false, reason: 'No reliable changed-file list: full validation.' };
  }
  if (paths.every(isDocumentation)) {
    const selection = emptySelection(false);
    return { ...selection, run_tests: false, docs_only: true, reason: 'Only documentation changed; runtime/browser/database tests are not applicable.' };
  }

  const selection = emptySelection(false);
  let unknownRuntimePath = false;

  for (const path of paths) {
    if (isDocumentation(path)) continue;

    // Changes to the planner/workflows validate the entire routing contract once.
    if (isCiInfrastructure(path)) {
      Object.assign(selection, emptySelection(true));
      continue;
    }

    if (path.startsWith('backend/')) {
      selection.run_backend = true;
      const production = isBackendProduction(path);
      const integration = isIntegrationTest(path);
      if (production || integration) selection.run_backend_database = true;
      if (isConversationDatabasePath(path)) selection.run_postgres_e2e = true;
      if (production && /^backend\/src\/(?:index|routes|middleware|services)\//.test(path)) selection.run_real_app_e2e = true;
      if (isPushStackPath(path)) selection.run_push_stack = true;
      continue;
    }

    if (path.startsWith('frontend/')) {
      selection.run_frontend = true;
      const production = isFrontendProduction(path);
      if (production || /^frontend\/e2e\//.test(path)) selection.run_browser_e2e = true;
      if (production) selection.run_real_app_e2e = true;
      if (isDocsScreenshotPath(path)) selection.run_docs_screenshots = true;
      if (isPushStackPath(path)) selection.run_push_stack = true;
      continue;
    }

    if (isPushStackPath(path)) {
      selection.run_push_stack = true;
      continue;
    }

    if (isDocsScreenshotPath(path)) {
      selection.run_docs_screenshots = true;
      continue;
    }

    // Images used by docs screenshots do not need app suites, but should verify
    // screenshot consistency.
    if (/^media\/screenshots\//.test(path)) {
      selection.run_docs_screenshots = true;
      continue;
    }

    // Root build/runtime/config inputs are deliberately conservative. New unknown
    // inputs must never silently avoid validation.
    unknownRuntimePath = true;
  }

  if (unknownRuntimePath) Object.assign(selection, emptySelection(true));
  const run_tests = CHECKS.some(name => selection[name]);
  return {
    ...selection,
    run_tests,
    docs_only: false,
    reason: `${unknownRuntimePath ? 'A shared or unknown runtime/build input changed; full validation. ' : ''}${describeSelection(selection)}`,
  };
}

export function coveringPullRequest(pulls, repository, branch, sha) {
  return pulls.find(pr => pr.state === 'open' && !pr.draft && ['dev','main'].includes(pr.base?.ref)
    && pr.head?.ref === branch && pr.head?.sha === sha && pr.head?.repo?.full_name === repository);
}

const SHA = /^[0-9a-f]{40}$/;

export function plan(env = process.env, execute = execFileSync) {
  const git = (...args) => execute('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const head = git('rev-parse','HEAD'), expected = env.EXPECTED_SHA || env.GITHUB_SHA;
  if (!SHA.test(expected ?? '') || head !== expected) throw new Error('Checked out a different source revision than the workflow requested');

  if (env.GITHUB_EVENT_NAME === 'push') {
    if (!/^refs\/heads\//.test(env.GITHUB_REF ?? '')) throw new Error('Only branch pushes use automatic CI planning');
    const repository = env.GITHUB_REPOSITORY, branch = env.GITHUB_REF.slice('refs/heads/'.length);
    if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid repository');
    const owner = repository.split('/')[0];
    const pulls = JSON.parse(execute('gh',['api',`repos/${repository}/pulls?state=open&head=${encodeURIComponent(owner+':'+branch)}&per_page=100`],{encoding:'utf8'}));
    if (!Array.isArray(pulls)) throw new Error('Invalid pull request response');
    const covering = coveringPullRequest(pulls,repository,branch,head);
    if (covering) {
      return {
        ...emptySelection(false),
        run_tests: false,
        docs_only: false,
        duplicate_push: true,
        source_sha: head,
        reason: `Push covered by PR #${covering.number} at the same head. The PR checks test the merge with its target branch.`,
      };
    }
  }

  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    return { ...classifyChanges([],env.GITHUB_EVENT_NAME), duplicate_push:false, source_sha:head };
  }

  const base = env.GITHUB_EVENT_NAME === 'pull_request' ? event.pull_request?.base?.sha : event.before;
  let paths = [];
  if (typeof base === 'string' && SHA.test(base) && !/^0+$/.test(base)) {
    git('cat-file','-e',`${base}^{commit}`);
    // No rename detection: a move from docs/ into code must include its new path.
    const raw = execute('git',['diff','--name-only','--no-renames','-z',base,head,'--'],{encoding:'utf8',maxBuffer:64*1024*1024});
    paths = raw.split('\0').filter(Boolean);
  }
  const result = classifyChanges(paths,env.GITHUB_EVENT_NAME);
  return { ...result, duplicate_push:false, source_sha:head };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = plan();
  console.log(JSON.stringify(result,null,2));
  for (const [key,value] of Object.entries(result)) appendFileSync(process.env.GITHUB_OUTPUT,`${key}=${String(value).replace(/[\r\n]/g,' ')}\n`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,`### CI plan\n\n${result.reason}\n\nTested checkout: \`${result.source_sha}\`.\n`);
}
