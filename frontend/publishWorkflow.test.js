import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const workflowUrl = new URL('../.github/workflows/publish.yml', import.meta.url);
const ciWorkflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url);

test('GHCR publishing is an explicit milestone operation with an immutable dev source', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const eventBlock = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('permissions:'));

  assert.match(workflow, /on:\s*\n\s+workflow_dispatch:/, 'publishing must be manually dispatched');
  assert.doesNotMatch(eventBlock, /^\s+push:/m, 'publishing must not run on pushes');
  assert.match(workflow, /source_sha:\s*[\s\S]*?required:\s*false[\s\S]*?type:\s*string/, 'manual publishing must accept an optional SHA');
  assert.match(workflow, /ref:\s*\$\{\{ inputs\.source_sha \|\| github\.sha \}\}/, 'checkout must use the requested immutable SHA');
  assert.match(workflow, /fetch-depth:\s*0/, 'the source history must be available for ancestry validation');
  assert.match(workflow, /source_sha="\$\{REQUESTED_SHA:-\$SELECTED_SHA\}"/);
  assert.match(workflow, /\[\[ "\$source_sha" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$source_sha"/);
  assert.match(workflow, /git fetch origin dev/);
  assert.match(workflow, /git merge-base --is-ancestor "\$source_sha" origin\/dev/);
  assert.strictEqual((workflow.match(/type=raw,value=dev/g) || []).length, 2, 'only the two raw dev image tags may be published');
  assert.doesNotMatch(workflow, /type=semver|type=raw,value=latest/, 'milestone publishing must not move semver or latest tags');
});

test('CI validates integration pushes and pull requests into dev or main', async () => {
  const workflow = await readFile(ciWorkflowUrl, 'utf8');
  const newline = String.fromCharCode(10);

  assert.ok(workflow.includes(['push:', '    branches: ["dev"]'].join(newline)));
  assert.ok(workflow.includes(['pull_request:', '    branches: ["dev", "main"]'].join(newline)));
});
