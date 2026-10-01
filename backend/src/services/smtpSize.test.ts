import { createServer, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: async () => ({ allowPrivateHosts: true, allowInsecureTls: true }) }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: async () => ({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null }) }));
import { discoverSmtpSize, applyAdvertisedSize, chooserAttachmentCeiling } from './smtpSize.js';
import { effectiveSendLimits } from './sendLimits.js';

describe('SMTP size discovery is read-only and provider-aware', () => {
  it('reads EHLO SIZE without authentication or sending and shares cached probes', async () => {
    const commands: string[] = []; let connections = 0;
    const server = createServer(socket => {
      connections++; socket.write('220 fixture SMTP\r\n'); let line = '';
      socket.on('data', data => {
        line += data.toString();
        while (line.includes('\r\n')) {
          const end = line.indexOf('\r\n'); const command = line.slice(0, end); line = line.slice(end+2); commands.push(command);
          if (command.startsWith('EHLO ')) socket.write('250-fixture\r\n250 SIZE 10485760\r\n');
          else socket.end('500 not supported\r\n');
        }
      });
    }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const account = { id: 'smtp-fixture', user_id: 'owner', smtp_host: 'fixture.test', smtp_port: (server.address() as AddressInfo).port, smtp_tls: 'none' };
      const results = await Promise.all([discoverSmtpSize(account), discoverSmtpSize(account)]);
      expect(results).toEqual([{ bytes: 10485760, source: 'advertised' }, { bytes: 10485760, source: 'advertised' }]);
      expect(connections).toBe(1); expect(commands).toHaveLength(1); expect(commands[0]).toMatch(/^EHLO /);
      expect(commands.join(' ')).not.toMatch(/AUTH|MAIL FROM|RCPT TO|DATA/);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('does not confuse MIME overhead, an absent limit, and installation policy', () => {
    const base = effectiveSendLimits('smtp', {});
    expect(applyAdvertisedSize(base, null)).toBe(base);
    const constrained = applyAdvertisedSize(base, 10*1024*1024, 5*1024*1024);
    expect(constrained.totalAttachmentBytes).toBe(5*1024*1024);
    expect(constrained.composedMessageBytes).toBe(10*1024*1024);
    expect(constrained.composedMessageFromFallback).toBe(false);
    expect(chooserAttachmentCeiling(constrained)).toBeLessThan(10*1024*1024*3/4);
    expect(applyAdvertisedSize(base, 100*1024*1024, 150*1024*1024).composedMessageBytes).toBe(100*1024*1024);
  });
});
