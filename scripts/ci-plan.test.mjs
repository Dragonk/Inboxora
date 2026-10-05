import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyChanges, coveringPullRequest, plan } from './ci-plan.mjs';

test('only explicit documentation paths may omit runtime tests',()=>{
  assert.equal(classifyChanges(['README.md','docs/wiki/Archive.md','docs/CHANGELOG.md'],'pull_request').run_tests,false);
  for (const path of ['backend/src/new-format.xyz','docs/fixture.sql','docs/keys/signing.asc','frontend/package.json','backend/package-lock.json',
    '.github/workflows/ci.yml','scripts/ci-plan.mjs','frontend/e2e/test.spec.ts','media/screenshots/mail.png','Dockerfile','.env.example']) {
    assert.equal(classifyChanges(['README.md',path],'pull_request').run_tests,true,path);
  }
  assert.equal(classifyChanges([],'push').run_tests,true);
  assert.equal(classifyChanges(['README.md'],'workflow_dispatch').run_tests,true);
});
test('deduplication requires an open same-repository PR at the exact head and a covered target',()=>{
  const p={number:31,state:'open',draft:false,head:{sha:'a'.repeat(40),ref:'dev',repo:{full_name:'Dragonk/Inboxora'}},base:{ref:'main'}};
  const matches=pr=>coveringPullRequest([pr],'Dragonk/Inboxora','dev','a'.repeat(40));
  assert.equal(matches(p)?.number,31);
  for(const change of [{state:'closed'},{draft:true},{head:{...p.head,sha:'b'.repeat(40)}},{base:{ref:'other'}},{head:{...p.head,repo:{full_name:'Fork/Inboxora'}}}])assert.equal(matches({...p,...change}),undefined);
});
test('real git diffs cover prose, changed CI and a rename out of documentation',()=>{
  const cwd=mkdtempSync(join(tmpdir(),'inboxora-ci-plan-'));
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const eventPath=join(cwd,'event.json');
  try{
    git('init','-b','dev');git('config','user.name','CI Test');git('config','user.email','ci@example.test');
    writeFileSync(join(cwd,'README.md'),'base\n');git('add','README.md');git('commit','-m','base');const base=git('rev-parse','HEAD');
    writeFileSync(join(cwd,'README.md'),'changed\n');git('commit','-am','docs');let sha=git('rev-parse','HEAD');
    writeFileSync(eventPath,JSON.stringify({pull_request:{base:{sha:base}}}));
    const execute=(cmd,args,opts)=>execFileSync(cmd,args,{...opts,cwd});
    const env={GITHUB_EVENT_NAME:'pull_request',GITHUB_EVENT_PATH:eventPath,GITHUB_SHA:sha};
    assert.equal(plan(env,execute).docs_only,true);
    git('mv','README.md','runtime.conf');git('commit','-m','move into runtime');sha=git('rev-parse','HEAD');
    assert.equal(plan({...env,GITHUB_SHA:sha},execute).run_tests,true);
    assert.throws(()=>plan({...env,GITHUB_SHA:'f'.repeat(40)},execute),/different source/);
    const push={...env,GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/dev',GITHUB_REPOSITORY:'Dragonk/Inboxora',GITHUB_SHA:sha};
    assert.throws(()=>plan(push,(cmd,args,opts)=>{if(cmd==='gh')throw new Error('API unavailable');return execute(cmd,args,opts);}),/API unavailable/);
  }finally{rmSync(cwd,{recursive:true,force:true});}
});
test('workflow gates retain the original check names and cannot hide a failed shard or planner',()=>{
  const browser=readFileSync(new URL('../.github/workflows/conversation-v2-playwright.yml',import.meta.url),'utf8');
  assert.match(browser,/name: Playwright browser E2E \(desktop \+ mobile\)/);
  assert.match(browser,/shard: \[1, 2, 3, 4\]/);
  assert.match(browser,/--shard=\$\{\{ matrix.shard \}\}\/4/);
  assert.match(browser,/if: always\(\)/);
  assert.match(browser,/needs\.shards\.result/);
  assert.doesNotMatch(browser,/services:|Run frontend unit suite/);
  for(const project of ['chromium-desktop','chromium-tablet','chromium-mobile-390','chromium-mobile','chromium-mobile-landscape'])assert.ok(browser.includes(`--project=${project}`));
  const db=readFileSync(new URL('../.github/workflows/conversation-v2-postgres-integration.yml',import.meta.url),'utf8');
  assert.match(db,/stage: \[upgrade, regression, scale\]/);
  assert.match(db,/name: Migrations and PostgreSQL integration/);
  assert.match(db,/needs\.validation\.result/);
});
