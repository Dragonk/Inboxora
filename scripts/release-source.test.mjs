import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateRelease } from './validate-release-source.mjs';

test('release sources require matching package versions, existing tag and merged main ancestry',()=>{
  const original=process.cwd(),cwd=mkdtempSync(join(tmpdir(),'inboxora-release-source-'));
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  function versions(version){
    for(const part of ['backend','frontend']){
      mkdirSync(join(cwd,part),{recursive:true});
      writeFileSync(join(cwd,part,'package.json'),JSON.stringify({name:part,version}));
      writeFileSync(join(cwd,part,'package-lock.json'),JSON.stringify({version,packages:{'':{version}}}));
    }
    mkdirSync(join(cwd,'frontend/packages/android/app'),{recursive:true});
    writeFileSync(join(cwd,'frontend/packages/android/app/build.gradle'),`versionName "${version}"\n`);
  }
  try{
    git('init','-b','main');git('config','user.name','CI Test');git('config','user.email','ci@example.test');
    versions('4.1.2');git('add','.');git('commit','-m','old release');const old=git('rev-parse','HEAD');git('tag','v4.1.2');
    versions('4.2.0');git('add','.');git('commit','-m','merged release');const head=git('rev-parse','HEAD');git('tag','v4.2.0');git('update-ref','refs/remotes/origin/main',head);
    process.chdir(cwd);
    assert.deepEqual(validateRelease('v4.2.0',git),{sha:head,tag:'v4.2.0',version:'4.2.0',latest:true});
    assert.throws(()=>validateRelease('main',git),/tag/);
    assert.throws(()=>validateRelease('v4.3.0',git));
    assert.throws(()=>validateRelease('v4.1.2',git),/checkout/);
    writeFileSync('backend/package.json',JSON.stringify({version:'4.1.2'}));
    assert.throws(()=>validateRelease('v4.2.0',git),/version/);git('restore','backend/package.json');
    git('checkout','--detach',old);assert.equal(validateRelease('v4.1.2',git).latest,false,'old tags must not replace latest');
    git('checkout','-b','unmerged');versions('4.3.0');git('add','.');git('commit','-m','not merged');git('tag','v4.3.0');
    assert.throws(()=>validateRelease('v4.3.0',git),'unmerged work must not become a release');
  }finally{process.chdir(original);rmSync(cwd,{recursive:true,force:true});}
});
test('release workflows require both native image builds and keep native artifacts in a draft',()=>{
  const docker=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  assert.match(docker,/runner: ubuntu-24.04-arm/);assert.doesNotMatch(docker,/setup-qemu/);
  assert.match(docker,/needs: \[source, build\]/);
  assert.match(docker,/PROMOTE_LATEST/);assert.match(docker,/tags.append\('latest'\)/);
  assert.match(docker,/validate-release-source.mjs/);
  const apps=readFileSync(new URL('../.github/workflows/publish-apps.yml',import.meta.url),'utf8');
  assert.match(apps,/Verify tag and app versions before using signing keys/);
  assert.match(apps,/draft: true/);
  const helper=readFileSync(new URL('../scripts/release.sh',import.meta.url),'utf8');
  assert.doesNotMatch(helper,/git push origin main|git commit/);
});
