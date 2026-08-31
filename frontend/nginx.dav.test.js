import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const config = readFileSync(new URL('./nginx.conf', import.meta.url), 'utf8');
const nativeConfig = readFileSync(new URL('../contrib/nginx.conf', import.meta.url), 'utf8');

function serverBlocks(source) {
  return source.split(/\nserver \{/).slice(1);
}

describe('DAV reverse proxy contract', () => {
  it('forwards CardDAV, CalDAV and RFC 6764 discovery paths in every public server block', () => {
    for (const server of serverBlocks(config)) {
      assert.match(server, /location \/carddav\/ \{[\s\S]*?proxy_pass\s+http:\/\/backend:3000;/);
      assert.match(server, /location \/caldav\/ \{[\s\S]*?proxy_pass\s+http:\/\/backend:3000;/);
      assert.match(server, /location = \/\.well-known\/carddav \{[\s\S]*?proxy_pass\s+http:\/\/backend:3000;/);
      assert.match(server, /location = \/\.well-known\/caldav \{[\s\S]*?proxy_pass\s+http:\/\/backend:3000;/);
    }
  });

  it('documents the same DAV routing for native nginx installations', () => {
    const uncommentedNativeConfig = nativeConfig.replace(/^#\s?/gm, '');

    for (const path of ['carddav', 'caldav']) {
      assert.match(
        uncommentedNativeConfig,
        new RegExp(`location = /\\.well-known/${path} \\{[\\s\\S]*?proxy_pass\\s+http://127\\.0\\.0\\.1:3000;`),
      );
      assert.match(
        uncommentedNativeConfig,
        new RegExp(`location /${path}/ \\{[\\s\\S]*?proxy_pass\\s+http://127\\.0\\.0\\.1:3000;`),
      );
    }
  });
});
