import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'vitest';


describe('how a failed mail sync is classified', () => {
  it('reports an authorization failure by its own code, not as INTERNAL_ERROR', async () => {
    // The live diagnostics said `INTERNAL_ERROR`, which told the user nothing. A token or grant problem arrives
    // as `ProviderAuthError`, which is not a `GraphApiError`; classifying it as INTERNAL_ERROR hid the one
    // instruction that helps. The calendar and contacts syncs already reported it correctly.
    const source = await readFile(new URL('./graphMailSync.ts', import.meta.url), 'utf8');
    const classifier = /const code = caught instanceof GraphApiError \|\| caught instanceof ProviderAuthError \? caught\.code : 'INTERNAL_ERROR';/g;
    // Both failure sites — folder discovery and the message page — use it.
    assert.equal((source.match(classifier) ?? []).length, 2);
    assert.match(source, /import \{ ProviderAuthError \} from '\.\.\/\.\.\/providerAuthService\.js';/);
  });

  it('does the same for the Gmail mail sync', async () => {
    const source = await readFile(new URL('../google/gmailMailSync.ts', import.meta.url), 'utf8');
    const classifier = /const code = caught instanceof GoogleApiError \|\| caught instanceof ProviderAuthError \? caught\.code : 'INTERNAL_ERROR';/g;
    assert.equal((source.match(classifier) ?? []).length, 2);
  });
});
