import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

// The rebuild action rewrites how an existing mailbox is grouped, so it must never
// be one click away: it opens a confirmation dialog, and that dialog starts in
// dry-run mode. These assertions guard the two things that would quietly remove
// the safety net — a direct call from the settings row, and a default of
// "write" instead of "report".
describe('Conversation rebuild settings contract', () => {
  const source = readFileSync(new URL('./ConversationRebuild.jsx', import.meta.url), 'utf8');

  it('always confirms before rebuilding', () => {
    // Starting the job happens from the dialog's own action, never from the
    // settings button, which may only open the dialog.
    assert.match(source, /setConfirming\(true\)/);
    assert.match(source, /const start = async \(\) => \{/);
    assert.match(source, /data-testid="conversation-rebuild-start"/);
    // The shared Dialog maps its testId prop onto data-testid.
    assert.match(source, /testId="conversation-rebuild-dialog"/);
  });

  it('defaults to a dry run so the first click reports instead of writing', () => {
    assert.match(source, /useState\(true\)/);
    assert.match(source, /conversationApi\.rebuild\(\{ dryRun \}\)/);
    assert.match(source, /data-testid="conversation-rebuild-dry-run"/);
  });

  it('reports progress and the result instead of firing and forgetting', () => {
    assert.match(source, /conversationApi\.rebuildStatus\(jobId\)/);
    assert.match(source, /conversation\.rebuildResultDry/);
    assert.match(source, /conversation\.rebuildResultApplied/);
    assert.match(source, /conversation\.rebuildNoChanges/);
  });

  it('explains a rate limit and a failure separately', () => {
    // The endpoint allows two calls a minute per user; a third must not look like
    // a broken feature.
    assert.match(source, /startError\.status === 429/);
    assert.match(source, /conversation\.rebuildRateLimited/);
    assert.match(source, /conversation\.rebuildFailed/);
    assert.match(source, /role="alert"/);
  });

  it('sends only the options the endpoint reads', () => {
    const api = readFileSync(new URL('../utils/conversationApi.js', import.meta.url), 'utf8');
    assert.match(api, /rebuild: \(\{ dryRun = true, accountId = null, limit, force = false \} = \{\}\)/);
    // `scope` was never read by the backend; sending it implied a control that
    // did not exist.
    assert.doesNotMatch(api, /JSON\.stringify\(\{ dryRun, scope \}\)/);
  });
});
