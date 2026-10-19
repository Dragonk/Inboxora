import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const config = readFileSync(new URL('./nginx.conf', import.meta.url), 'utf8');
const nativeConfig = readFileSync(new URL('../contrib/nginx.conf', import.meta.url), 'utf8');
const devCompose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
const ghcrCompose = readFileSync(new URL('../docker-compose.ghcr.yml', import.meta.url), 'utf8');

function serverBlocks(source) {
  return source.split(/\nserver \{/).slice(1);
}

describe('Live push (/ws) reverse proxy contract', () => {
  it('proxies the live push WebSocket to the API with an upgrade and a long timeout', () => {
    assert.doesNotMatch(config, /ntfy/);
    assert.doesNotMatch(config, /\$connection_upgrade/);
    assert.doesNotMatch(config, /location = \/push \{/);
    assert.doesNotMatch(config, /location \^~ \/push\//);
    assert.doesNotMatch(config, /location ~ "\^\/up/);
    assert.doesNotMatch(config, /location \^~ \/v1\//);
    for (const server of serverBlocks(config)) {
      assert.match(server, /location \/ws \{[\s\S]*?proxy_pass\s+http:\/\/mailflow_api;/);
      assert.match(server, /location \/ws \{[\s\S]*?proxy_set_header\s+Upgrade \$http_upgrade;/);
      assert.match(server, /location \/ws \{[\s\S]*?Connection "upgrade";/);
      assert.match(server, /location \/ws \{[\s\S]*?proxy_read_timeout\s+86400s;/);
    }
  });

  it('documents the same /ws routing for native nginx installations', () => {
    for (const source of [nativeConfig, nativeConfig.replace(/^#\s?/gm, '')]) {
      assert.match(source, /location \/ws \{[\s\S]*?proxy_pass\s+http:\/\/127\.0\.0\.1:3000;/);
      assert.match(source, /location \/ws \{[\s\S]*?proxy_set_header\s+Upgrade \$http_upgrade;/);
      assert.match(source, /location \/ws \{[\s\S]*?Connection "upgrade";/);
      assert.match(source, /location \/ws \{[\s\S]*?proxy_read_timeout\s+86400s;/);
      assert.doesNotMatch(source, /ntfy/);
      assert.doesNotMatch(source, /location \^~ \/push\//);
    }
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

describe('MCP reverse proxy contract', () => {
  it('serves MCP directly on TLS and only through an HTTPS-forwarding trusted HTTP hop', () => {
    const blocks = serverBlocks(config);
    const tls = blocks.find(block => block.includes('listen 443 ssl;'));
    const http = blocks.find(block => block.includes('listen 80;'));
    assert.ok(tls, 'TLS server block missing');
    assert.ok(http, 'internal HTTP server block missing');

    assert.match(tls, /location = \/mcp \{[\s\S]*?proxy_pass http:\/\/mailflow_api;/);
    assert.match(tls, /location = \/mcp \{[\s\S]*?proxy_buffering off;/);
    assert.doesNotMatch(tls, /location = \/mcp \{[\s\S]*?return 426;/);

    const guard = 'if ($http_x_forwarded_proto != "https") { return 426; }';
    assert.ok(http.includes(guard), 'plaintext MCP requests must be refused');
    assert.match(http, /location = \/mcp \{[\s\S]*?proxy_pass http:\/\/mailflow_api;/);
    assert.match(http, /location \^~ \/oauth\/mcp\/ \{[\s\S]*?return 426;/);
    assert.match(http, /location \^~ \/\.well-known\/oauth- \{[\s\S]*?return 426;/);
    assert.doesNotMatch(http, /proxy_pass http:\/\/backend:3000;/);
  });

  it('does not publish the HTTP reverse-proxy listener on public interfaces by default', () => {
    const binding = '${APP_HTTP_BIND:-127.0.0.1}:${APP_HTTP_PORT:-80}:80';
    assert.ok(devCompose.includes(binding));
    assert.ok(ghcrCompose.includes(binding));
    assert.match(nativeConfig, /listen 127\.0\.0\.1:80;/);
    assert.match(nativeConfig, /location = \/mcp \{[\s\S]*?if \(\$http_x_forwarded_proto != "https"\) \{ return 426; \}/);
  });
});
