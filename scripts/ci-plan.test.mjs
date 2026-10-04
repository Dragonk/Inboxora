import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyChanges, coveringPullRequest, plan } from './ci-plan.mjs';

test('documentation-only changes omit runtime validation',()=>{
  const result=classifyChanges(['README.md','docs/wiki/Archive.md','docs/CHANGELOG.md'],'pull_request');
  assert.equal(result.run_tests,false);
  assert.equal(result.docs_only,true);
});

test('small unit-test PRs select only their own stack',()=>{
  const backend=classifyChanges(['backend/src/routes/oidc.insecurefetch.test.ts'],'pull_request');
  assert.equal(backend.run_backend,true);
  for(const key of ['run_backend_database','run_frontend','run_browser_e2e','run_postgres_e2e','run_real_app_e2e','run_docs_screenshots','run_push_stack']) assert.equal(backend[key],false,key);

  const frontend=classifyChanges(['frontend/src/fonts.test.ts'],'pull_request');
  assert.equal(frontend.run_frontend,true);
  for(const key of ['run_backend','run_backend_database','run_browser_e2e','run_postgres_e2e','run_real_app_e2e','run_docs_screenshots','run_push_stack']) assert.equal(frontend[key],false,key);
});

test('production changes select relevant integration layers',()=>{
  const ui=classifyChanges(['frontend/src/components/MessagePane.tsx'],'pull_request');
  assert.equal(ui.run_frontend,true);
  assert.equal(ui.run_browser_e2e,true);
  assert.equal(ui.run_real_app_e2e,true);
  assert.equal(ui.run_docs_screenshots,true);
  assert.equal(ui.run_backend,false);

  const backend=classifyChanges(['backend/src/routes/oidc.ts'],'pull_request');
  assert.equal(backend.run_backend,true);
  assert.equal(backend.run_backend_database,true);
  assert.equal(backend.run_real_app_e2e,true);
  assert.equal(backend.run_frontend,false);

  const migration=classifyChanges(['backend/migrations/0123_example.sql'],'pull_request');
  assert.equal(migration.run_backend,true);
  assert.equal(migration.run_backend_database,true);
  assert.equal(migration.run_postgres_e2e,true);
});

test('specialized paths select specialized checks',()=>{
  const push=classifyChanges(['frontend/nginx.conf'],'pull_request');
  assert.equal(push.run_frontend,true);
  assert.equal(push.run_push_stack,true);

  const screenshot=classifyChanges(['media/screenshots/inbox.png'],'pull_request');
  assert.equal(screenshot.run_docs_screenshots,true);
  assert.equal(screenshot.run_backend,false);
  assert.equal(screenshot.run_frontend,false);
});

test('unknown runtime and CI infrastructure changes fail safe to full validation',()=>{
  for (const path of ['Dockerfile','.env.example','docs/fixture.sql','.github/workflows/ci.yml','scripts/ci-plan.mjs']) {
    const result=classifyChanges([path],'pull_request');
    for(const key of ['run_backend','run_backend_database','run_frontend','run_browser_e2e','run_postgres_e2e','run_real_app_e2e','run_docs_screenshots','run_push_stack']) assert.equal(result[key],true,`${path}: ${key}`);
  }
  const manual=classifyChanges(['README.md'],'workflow_dispatch');
  assert.equal(manual.run_tests,true);
  assert.equal(manual.run_browser_e2e,true);
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
    assert.equal(plan({...env,GITHUB_SHA:sha},execute).run_backend,true);
    assert.throws(()=>plan({...env,GITHUB_SHA:'f'.repeat(40)},execute),/different source/);
    const push={...env,GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/dev',GITHUB_REPOSITORY:'Dragonk/Inboxora',GITHUB_SHA:sha};
    assert.throws(()=>plan(push,(cmd,args,opts)=>{if(cmd==='gh')throw new Error('API unavailable');return execute(cmd,args,opts);}),/API unavailable/);
  }finally{rmSync(cwd,{recursive:true,force:true});}
});

test('workflow gates keep required check names, selective outputs and 15 minute caps',()=>{
  const ci=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
  assert.match(ci,/needs\.changes\.outputs\.run_backend == 'true'/);
  assert.match(ci,/needs\.changes\.outputs\.run_backend_database == 'true'/);
  assert.match(ci,/needs\.changes\.outputs\.run_frontend == 'true'/);

  const browser=readFileSync(new URL('../.github/workflows/conversation-v2-playwright.yml',import.meta.url),'utf8');
  assert.match(browser,/name: Playwright browser E2E \(desktop \+ mobile\)/);
  assert.match(browser,/shard: \[1, 2, 3, 4\]/);
  assert.match(browser,/run_browser_e2e/);
  assert.match(browser,/timeout-minutes: 15/);

  const db=readFileSync(new URL('../.github/workflows/conversation-v2-postgres-integration.yml',import.meta.url),'utf8');
  assert.match(db,/stage: \[upgrade, regression, scale\]/);
  assert.match(db,/run_postgres_e2e/);
  assert.match(db,/timeout-minutes: 15/);

  for (const [file,output] of [
    ['../.github/workflows/conversation-v2-real-app-playwright.yml','run_real_app_e2e'],
    ['../.github/workflows/docs-screenshots.yml','run_docs_screenshots'],
    ['../.github/workflows/push-stack.yml','run_push_stack'],
  ]) {
    const text=readFileSync(new URL(file,import.meta.url),'utf8');
    assert.ok(text.includes(output),file);
    assert.match(text,/timeout-minutes: 15/,file);
  }
});
