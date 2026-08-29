import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { coarsenUserAgent, scrubReport, collectEnvironment, hashRefAsync } from './diagnostics.js';

describe('hashRefAsync', () => {
  it('matches the backend hashRef format: 8 hex, deterministic per salt', async () => {
    const a = await hashRefAsync('acct-1', 'salt');
    const b = await hashRefAsync('acct-1', 'salt');
    const c = await hashRefAsync('acct-1', 'other-salt');
    assert.match(a, /^[0-9a-f]{8}$/);
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

describe('coarsenUserAgent', () => {
  it('reduces a UA to browser+major and OS family only', () => {
    const chrome = coarsenUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36');
    assert.equal(chrome.browser, 'Chrome 141');
    assert.equal(chrome.os, 'macOS');
    const ios = coarsenUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Mobile/15E148 Safari/604.1');
    assert.equal(ios.os, 'iOS');
    assert.equal(ios.browser, 'Safari 17');
  });
});

describe('scrubReport (client safety net)', () => {
  it('redacts PII patterns and keeps clean values', () => {
    const { scrubbed, counters } = scrubReport({ a: 'x@y.com', b: 'INBOX', c: ['1.2.3.4', 3], d: 'sk-secret' });
    assert.equal(scrubbed.a, '[redacted]');
    assert.equal(scrubbed.b, 'INBOX');
    assert.equal(scrubbed.c[0], '[redacted]');
    assert.equal(scrubbed.c[1], 3);
    assert.equal(scrubbed.d, '[redacted]');
    assert.ok(counters.hitsRedacted >= 3);
  });
});

describe('collectEnvironment', () => {
  it('returns a non-identifying environment shape (no raw UA)', () => {
    const env = collectEnvironment({ locale: 'de', theme: 'dark', uiScale: 1.2 });
    assert.equal(env.locale, 'de');
    assert.equal(env.theme, 'dark');
    assert.equal(env.uiScale, 1.2);
    assert.equal(env.platform, 'web');
    assert.equal(typeof env.tzOffsetMinutes, 'number');
    assert.ok('viewport' in env);
    assert.ok(!JSON.stringify(env).includes('Mozilla'));
  });
});
