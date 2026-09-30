import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// An allowlist, not a list of known source extensions. A new build/config/input
// file must run tests by default. Test fixtures under docs/ are not prose.
export function isDocumentation(path) {
  return /^[^/]+\.md$/.test(path)
    || /^docs\/.*\.md$/.test(path)
    || /^\.github\/(?:ISSUE_TEMPLATE\/[^/]+\.md|PULL_REQUEST_TEMPLATE\.md)$/.test(path);
}
export function classifyChanges(paths, eventName) {
  if (eventName === 'workflow_dispatch') return { run_tests: true, reason: 'Manual validation always runs the full selected workflow.' };
  if (!['push', 'pull_request'].includes(eventName)) return { run_tests: true, reason: 'Unknown event: full validation.' };
  if (paths.length && paths.every(isDocumentation)) return { run_tests: false, reason: 'Only documentation changed; runtime/browser/database tests are not applicable.' };
  return { run_tests: true, reason: paths.length ? 'Code, build inputs, tests or CI configuration changed.' : 'No reliable changed-file list: full validation.' };
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
    if (covering) return { run_tests:false, docs_only:false, duplicate_push:true, source_sha:head,
      reason:`Push covered by PR #${covering.number} at the same head. The PR checks test the merge with its target branch.` };
  }
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') return {...classifyChanges([],env.GITHUB_EVENT_NAME),docs_only:false,duplicate_push:false,source_sha:head};
  const base = env.GITHUB_EVENT_NAME === 'pull_request' ? event.pull_request?.base?.sha : event.before;
  let paths = [];
  if (typeof base === 'string' && SHA.test(base) && !/^0+$/.test(base)) {
    git('cat-file','-e',`${base}^{commit}`);
    // No rename detection: a move from docs/ into code must include its new path.
    const raw = execute('git',['diff','--name-only','--no-renames','-z',base,head,'--'],{encoding:'utf8',maxBuffer:64*1024*1024});
    paths = raw.split('\0').filter(Boolean);
  }
  const result = classifyChanges(paths,env.GITHUB_EVENT_NAME);
  return {...result, docs_only:!result.run_tests, duplicate_push:false, source_sha:head};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = plan();
  console.log(JSON.stringify(result,null,2));
  for (const [key,value] of Object.entries(result)) appendFileSync(process.env.GITHUB_OUTPUT,`${key}=${String(value).replace(/[\r\n]/g,' ')}\n`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,`### CI plan\n\n${result.reason}\n\nTested checkout: \`${result.source_sha}\`.\n`);
}
