import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(new URL('./useWebSocket.ts', import.meta.url), 'utf8');

describe('WebSocket BFCache wake contract', () => {
  it('reuses the wake path only for persisted pageshow restores', () => {
    assert.match(source, /const onPageShow = \(event: PageTransitionEvent\) => \{ if \(event\.persisted\) revive\(\); \};/);
    assert.match(source, /window\.addEventListener\('pageshow', onPageShow\)/);
    assert.match(source, /window\.removeEventListener\('pageshow', onPageShow\)/);
    assert.match(source, /const revive = \(\) => \{[\s\S]*?requestMailRefresh\(undefined, \{ invalidateCache: false \}\);[\s\S]*?restorePushSubscription\(\);/);
    assert.match(source, /import \{ requestMailRefresh, cancelMailRefresh \} from '\.\.\/utils\/mailRefresh\.ts';/);
  });
});
