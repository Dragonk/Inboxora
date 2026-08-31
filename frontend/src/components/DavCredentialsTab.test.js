import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('DAV application password settings contract', () => {
  it('provides creation, one-time secret handling, DAVx5 discovery guidance and revocation', async () => {
    const source = await readFile(new URL('./AdminPanel.jsx', import.meta.url), 'utf8');
    assert.match(source, /function DavCredentialsTab\(\)/);
    assert.match(source, /api\.davCredentials\.list\(\)/);
    assert.match(source, /api\.davCredentials\.create\(label\.trim\(\)\)/);
    assert.match(source, /navigator\.clipboard\.writeText\(secret\)/);
    assert.match(source, /\.well-known\/carddav/);
    assert.match(source, /\.well-known\/caldav/);
    assert.match(source, /api\.davCredentials\.revoke\(credential\.id\)/);
    assert.match(source, /adminTab === 'dav-credentials'/);
  });
});
