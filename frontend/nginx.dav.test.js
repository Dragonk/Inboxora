import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const config = readFileSync(new URL('./nginx.conf', import.meta.url), 'utf8');
const nativeConfig = readFileSync(new URL('../contrib/nginx.conf', import.meta.url), 'utf8');

function serverBlocks(source) {
  return source.split(/\nserver \{/).slice(1);
}

describe('UnifiedPush (/push) reverse proxy contract', () => {
  it('proxies /push to the bundled ntfy with WebSocket upgrade and a long timeout', () => {
    assert.match(config, /upstream mailflow_ntfy \{[\s\S]*?server ntfy:80 resolve;/);
    assert.match(config, /map \$http_upgrade \$connection_upgrade/);
    for (const server of serverBlocks(config)) {
      assert.match(server, /location = \/push \{\s*return 301 \/push\/;/);
      assert.match(server, /location \^~ \/push\/ \{[\s\S]*?proxy_pass\s+http:\/\/mailflow_ntfy\/;/);
      assert.match(server, /location \^~ \/push\/ \{[\s\S]*?proxy_set_header\s+Upgrade \$http_upgrade;/);
      assert.match(server, /location \^~ \/push\/ \{[\s\S]*?Connection \$connection_upgrade;/);
      assert.match(server, /location \^~ \/push\/ \{[\s\S]*?proxy_read_timeout\s+3600s;/);
    }
  });

  it('documents the same /push routing for native nginx installations', () => {
    const uncommented = nativeConfig.replace(/^#\s?/gm, '');
    assert.match(uncommented, /location \^~ \/push\/ \{[\s\S]*?proxy_pass\s+http:\/\/127\.0\.0\.1:2586\/;/);
    assert.match(uncommented, /location \^~ \/push\/ \{[\s\S]*?proxy_set_header\s+Upgrade \$http_upgrade;/);
    assert.match(uncommented, /location \^~ \/push\/ \{[\s\S]*?proxy_read_timeout\s+3600s;/);
  });
});

describe('DAV reverse proxy contract', () => {
  it('forwards CardDAV, CalDAV and RFC 6764 discovery paths in every public server block', () => {
    assert.match(config, /server backend:3000 resolve;/);
    assert.match(config, /resolver 127\.0\.0\.11 valid=10s/);
    for (const server of serverBlocks(config)) {
      assert.match(server, /location \/carddav\/ \{[\s\S]*?proxy_pass\s+http:\/\/mailflow_api;/);
      assert.match(server, /location \/caldav\/ \{[\s\S]*?proxy_pass\s+http:\/\/mailflow_api;/);
      assert.match(server, /location = \/\.well-known\/carddav \{[\s\S]*?proxy_pass\s+http:\/\/mailflow_api;/);
      assert.match(server, /location = \/\.well-known\/caldav \{[\s\S]*?proxy_pass\s+http:\/\/mailflow_api;/);
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
