import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(new URL('./useWebSocket.ts', import.meta.url), 'utf8');

describe('New-mail notification content contract', () => {
  it('builds a Gmail-style card: sender title, subject plus snippet preview', () => {
    assert.match(source, /title: latest\.fromName \|\| latest\.fromEmail \|\| t\('notifications\.newMessage'\),/);
    assert.match(source, /body: \[latest\.subject, latest\.snippet\]\.filter\(Boolean\)\.join\('\\n'\) \|\| t\('common\.noSubject'\),/);
  });
});
