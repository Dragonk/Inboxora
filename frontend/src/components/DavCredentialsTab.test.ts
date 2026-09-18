import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('DAV application password settings contract', () => {
  it('provides creation, one-time secret handling, DAVx5 discovery guidance and revocation', async () => {
    const source = await readFile(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
    assert.match(source, /function DavCredentialsTab\(\)/);
    assert.match(source, /api\.davCredentials\.list\(\)/);
    assert.match(source, /api\.davCredentials\.create\(label\.trim\(\), maxMode\)/);
    assert.match(source, /navigator\.clipboard\.writeText\(secret\)/);
    assert.match(source, /\.well-known\/carddav/);
    assert.match(source, /\.well-known\/caldav/);
    assert.match(source, /api\.davCredentials\.revoke\(credential\.id\)/);
    assert.match(source, /adminTab === 'dav-credentials'/);
    // The device password carries its own ceiling and the list shows it.
    assert.match(source, /data-testid="dav-credential-max-mode"/);
    assert.match(source, /value="read_only"/);
    assert.match(source, /admin\.davCredentials\.mode/);
  });
});
