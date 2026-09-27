import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const workflowUrl = new URL('../.github/workflows/publish.yml', import.meta.url);
const ciWorkflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url);
const validator = fileURLToPath(new URL('../scripts/validate-dev-image-source.sh', import.meta.url));

test('GHCR publication is manual and publishes the shared dev tag only after both native builds pass', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const eventBlock = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('permissions:'));
  assert.match(workflow, /on:\s*\n\s+workflow_dispatch:/);
  assert.doesNotMatch(eventBlock, /^\s+push:/m);
  assert.doesNotMatch(eventBlock, /platforms:/, 'single-platform overrides must not replace shared dev manifests');
  assert.match(workflow, /source_sha:\s*[\s\S]*?required:\s*false[\s\S]*?type:\s*string/);
  assert.match(workflow, /ref:\s*\$\{\{ inputs\.source_sha \|\| github\.sha \}\}/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /bash scripts\/validate-dev-image-source.sh/);
  assert.match(workflow, /arch: amd64\s+runner: ubuntu-24.04/);
  assert.match(workflow, /arch: arm64\s+runner: ubuntu-24.04-arm/);
  assert.match(workflow, /publish:\s*\n\s+needs: \[source, build\]/);
  assert.strictEqual((workflow.match(/push-by-digest=true/g) || []).length, 2);
  assert.match(workflow, /assert platforms == \{\('linux','amd64'\),\('linux','arm64'\)\}/);
  const validate = workflow.indexOf('assert platforms ==');
  const promote = workflow.indexOf("image + ':dev'");
  assert.ok(validate >= 0 && promote > validate);
  assert.doesNotMatch(workflow, /type=semver|type=raw,value=latest/);
});

test('source gate validates ancestry against the explicitly selected repository branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inboxora-publish-source-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  try {
    git('init','-b','main');git('config','user.name','Workflow Test');git('config','user.email','workflow@example.test');
    git('commit','--allow-empty','-m','base');const base=git('rev-parse','HEAD');
    git('checkout','-b','fix/storage');git('commit','--allow-empty','-m','hotfix');const hotfix=git('rev-parse','HEAD');
    git('checkout','main');git('commit','--allow-empty','-m','unrelated');const other=git('rev-parse','HEAD');
    git('remote','add','origin',resolve(root));
    const check=(sha:string,branch='fix/storage',type='branch')=>spawnSync('bash',[validator],{
      cwd:root,encoding:'utf8',env:{...process.env,REQUESTED_SHA:sha,SELECTED_SHA:sha,SELECTED_REF:branch,SELECTED_REF_TYPE:type},
    });
    git('checkout','--detach',hotfix);assert.equal(check(hotfix).status,0);
    git('checkout','--detach',base);assert.equal(check(base).status,0,'a selected-branch ancestor is a valid pinned source');
    git('checkout','--detach',other);assert.notEqual(check(other).status,0,'another branch commit must be rejected');
    assert.notEqual(check('not-a-sha').status,0);
    assert.notEqual(check(other,'main','tag').status,0);
    assert.notEqual(check(other,'--upload-pack=invalid').status,0);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('CI validates integration pushes and pull requests into dev or main', async () => {
  const workflow = await readFile(ciWorkflowUrl, 'utf8');
  const newline = String.fromCharCode(10);
  assert.ok(workflow.includes(['push:', '    branches: ["dev"]'].join(newline)));
  assert.ok(workflow.includes(['pull_request:', '    branches: ["dev", "main"]'].join(newline)));
});
