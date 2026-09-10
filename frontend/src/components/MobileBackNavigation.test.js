import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';

it('the Android host and the shared navigation controller use the same bridge', async () => {
  const hook = await readFile(new URL('../hooks/useBackNavigation.js', import.meta.url), 'utf8');
  const activity = await readFile(new URL('../../packages/android/app/src/main/java/io/github/dragonk/inboxora/MainActivity.java', import.meta.url), 'utf8');
  assert.match(hook, /window\.__inboxoraHandleAndroidBack\s*=/);
  assert.match(activity, /window\.__inboxoraHandleAndroidBack/);
  assert.doesNotMatch(hook, /__mailflowHandleAndroidBack/);
});
