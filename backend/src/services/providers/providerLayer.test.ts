import { describe, expect, it } from 'vitest';
import {
  PROVIDER_OPERATIONS,
  isDavMode,
  isMailTransport,
  normalizeMailTransport,
} from './contracts.js';
import {
  allow,
  combinePermissions,
  deniedCapabilities,
  deny,
  effectiveDavMode,
  readOnlyCapabilities,
  sourceCapabilities,
} from './capabilities.js';
import {
  DEFAULT_PROVIDER_REGISTRATIONS,
  ProviderRegistry,
  ProviderRegistryError,
  createDefaultRegistry,
} from './registry.js';
import type { ProviderRegistration } from './registry.js';

describe('provider contracts', () => {
  it('recognises the supported mail transports', () => {
    expect(isMailTransport('imap_smtp')).toBe(true);
    expect(isMailTransport('microsoft_graph')).toBe(true);
    expect(isMailTransport('gmail_api')).toBe(true);
    expect(isMailTransport('pop3')).toBe(false);
  });

  it('treats an unknown transport as the legacy IMAP/SMTP one', () => {
    expect(normalizeMailTransport(undefined)).toBe('imap_smtp');
    expect(normalizeMailTransport('nonsense')).toBe('imap_smtp');
    expect(normalizeMailTransport('gmail_api')).toBe('gmail_api');
  });

  it('recognises DAV modes', () => {
    expect(isDavMode('off')).toBe(true);
    expect(isDavMode('read_write')).toBe(true);
    expect(isDavMode('write')).toBe(false);
  });
});

describe('effective permissions', () => {
  it('allows only when every layer allows', () => {
    expect(combinePermissions([allow(), allow()], 'atomic')).toEqual({ allowed: true, conflictProtection: 'atomic' });
  });

  it('reports the first denial reason', () => {
    const result = combinePermissions([allow(), deny('COLLECTION_READ_ONLY'), deny('OPERATION_FORBIDDEN')], 'best_effort');
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe('COLLECTION_READ_ONLY');
    expect(result.conflictProtection).toBe('best_effort');
  });

  it('falls back to a safe reason code when a factor omits one', () => {
    const result = combinePermissions([{ allowed: false }], 'unsupported');
    expect(result.reasonCode).toBe('OPERATION_FORBIDDEN');
  });

  it('carries limits through to the capability', () => {
    const result = combinePermissions([allow()], 'best_effort', { maxBytes: 1024 });
    expect(result.limits).toEqual({ maxBytes: 1024 });
  });

  it('denies every mutation for a read-only collection but keeps read', () => {
    const capabilities = readOnlyCapabilities({ reasonCode: 'COLLECTION_READ_ONLY' });
    expect(capabilities.operations.read.allowed).toBe(true);
    for (const operation of PROVIDER_OPERATIONS) {
      if (operation === 'read') continue;
      expect(capabilities.operations[operation].allowed).toBe(false);
      expect(capabilities.operations[operation].reasonCode).toBe('COLLECTION_READ_ONLY');
    }
  });

  it('denies an entire capability map with one code', () => {
    const operations = deniedCapabilities('PROVIDER_AUTH_REQUIRED');
    for (const operation of PROVIDER_OPERATIONS) {
      expect(operations[operation]).toEqual({ allowed: false, reasonCode: 'PROVIDER_AUTH_REQUIRED', conflictProtection: 'unsupported' });
    }
  });

  it('keeps per-operation conflict protection and explicit denials', () => {
    const capabilities = sourceCapabilities({
      conflictProtection: { read: 'atomic', create: 'atomic', update: 'atomic', delete: 'best_effort', rsvp: 'best_effort', send: 'unsupported' },
      deny: { send: 'OPERATION_FORBIDDEN' },
    });
    expect(capabilities.operations.delete).toEqual({ allowed: true, conflictProtection: 'best_effort' });
    expect(capabilities.operations.send.allowed).toBe(false);
    expect(capabilities.operations.send.reasonCode).toBe('OPERATION_FORBIDDEN');
  });
});

describe('effective DAV mode', () => {
  it('lets a device password narrow access but never widen it', () => {
    expect(effectiveDavMode('read_write', 'read_only', true)).toBe('read_only');
    expect(effectiveDavMode('read_only', 'read_write', true)).toBe('read_only');
    expect(effectiveDavMode('off', 'read_write', true)).toBe('off');
  });

  it('downgrades a write mode when the collection is not writable', () => {
    expect(effectiveDavMode('read_write', null, false)).toBe('read_only');
    expect(effectiveDavMode('read_write', 'read_write', true)).toBe('read_write');
  });
});

describe('provider registry', () => {
  it('registers the default adapters and resolves them by transport', () => {
    const registry = createDefaultRegistry();
    expect(registry.list()).toHaveLength(DEFAULT_PROVIDER_REGISTRATIONS.length);
    expect(registry.forMailTransport('microsoft_graph')?.key).toBe('microsoft_graph');
    expect(registry.forMailTransport('gmail_api')?.features).toContain('mail');
    expect(registry.supports('gmail_api', 'calendars')).toBe(false);
    expect(registry.supports('microsoft_graph', 'calendars')).toBe(true);
  });

  it('declares the ICS subscription as read-only', () => {
    const registry = createDefaultRegistry();
    expect(registry.conflictProtectionFor('ical_url', 'read')).toBe('atomic');
    expect(registry.conflictProtectionFor('ical_url', 'update')).toBe('unsupported');
    expect(registry.get('ical_url')?.writeThrough).toBe(false);
  });

  it('rejects duplicate registrations', () => {
    const registry = createDefaultRegistry();
    expect(() => registry.register(DEFAULT_PROVIDER_REGISTRATIONS[0])).toThrow(ProviderRegistryError);
  });

  it('rejects a descriptor that omits conflict protection', () => {
    const registry = new ProviderRegistry();
    const broken = {
      key: 'caldav',
      features: ['calendars'],
      writeThrough: true,
      conflictProtection: { read: 'atomic' },
    } as unknown as ProviderRegistration;
    expect(() => registry.register(broken)).toThrow(/conflict protection/);
  });

  it('reports unsupported for an unknown provider/operation instead of assuming a guarantee', () => {
    const registry = new ProviderRegistry();
    expect(registry.conflictProtectionFor('caldav', 'update')).toBe('unsupported');
    expect(registry.supports('caldav', 'mail')).toBe(false);
  });
});
