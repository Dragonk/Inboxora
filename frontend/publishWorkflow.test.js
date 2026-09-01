import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const workflowUrl = new URL('../.github/workflows/publish.yml', import.meta.url);
const ciWorkflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url);

test('GHCR publishing supports an explicitly scoped dev image without moving latest', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /branches:\s*\n\s*- dev/, 'the publishing workflow must run for dev pushes');
  assert.match(
    workflow,
    /type=raw,value=dev,enable=\$\{\{ github\.ref == 'refs\/heads\/dev' \}\}/,
    'the publishing workflow must publish the dev tag only from dev',
  );
  assert.match(workflow, /type=semver,pattern=latest/, 'only a valid semantic-version tag may move latest');
  assert.doesNotMatch(workflow, /type=raw,value=latest/, 'a loose v* tag must never move latest');
});

test('CI validates integration pushes and pull requests into dev or main', async () => {
  const workflow = await readFile(ciWorkflowUrl, 'utf8');
  const newline = String.fromCharCode(10);

  assert.ok(workflow.includes(['push:', '    branches: ["dev"]'].join(newline)));
  assert.ok(workflow.includes(['pull_request:', '    branches: ["dev", "main"]'].join(newline)));
});
