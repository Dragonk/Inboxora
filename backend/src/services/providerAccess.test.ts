import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from './providers/registry.js';
import type { ProviderRegistration } from './providers/registry.js';
import {
  collectionDavWritable,
  collectionIsWritable,
  davWriteRefusalMessage,
  normalizeDavMode,
  resolveCollectionAccess,
} from './providerAccess.js';

const ALL_ATOMIC = Object.freeze({
  read: 'atomic', create: 'atomic', update: 'atomic', delete: 'atomic', rsvp: 'best_effort', send: 'unsupported',
} as const);

function registration(overrides: Partial<ProviderRegistration> & Pick<ProviderRegistration, 'key' | 'features'>): ProviderRegistration {
  return {
    source: 'caldav',
    writeThrough: false,
    conflictProtection: { ...ALL_ATOMIC },
    ...overrides,
  } as ProviderRegistration;
}

/**
 * A registry built per test rather than the default one: the point of these cases
 * is that the *declared* capabilities decide, so each case states the declaration
 * it is testing.
 */
function registryWith(...providers: ProviderRegistration[]): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const provider of providers) registry.register(provider);
  return registry;
}

describe('collection access comes from the capability model', () => {
  it('accepts every mutation for a local collection the adapter owns', () => {
    const registry = registryWith(registration({ key: 'local', source: 'local', features: ['calendars'] }));
    const row = { source: 'local', read_only: false, dav_mode: 'read_write' };
    for (const operation of ['read', 'create', 'update', 'delete'] as const) {
      const access = resolveCollectionAccess(row, { feature: 'calendars', operation }, { registry });
      expect(access.allowed, operation).toBe(true);
      expect(access.providerKey).toBe('local');
    }
  });

  it('refuses a mutation whose origin has no adapter that writes through', () => {
    for (const source of ['google', 'microsoft', 'carddav', 'caldav'] as const) {
      const registry = registryWith(registration({ key: 'carddav', source, features: ['calendars'], writeThrough: false }));
      const access = resolveCollectionAccess({ source, read_only: false, dav_mode: 'read_write' }, { feature: 'calendars', operation: 'update' }, { registry });
      expect(access.allowed, source).toBe(false);
      expect(access.reasonCode, source).toBe('OPERATION_FORBIDDEN');
      // ... and yet it stays readable: a read-only source is not an absent one.
      const read = resolveCollectionAccess({ source, read_only: false, dav_mode: 'read_write' }, { feature: 'calendars', operation: 'read' }, { registry });
      expect(read.allowed, source).toBe(true);
    }
  });

  it('changes the decision when the adapter declares write-through', () => {
    // An adapter that writes through is necessary but not sufficient: the collection must also say the
    // origin permits writes and the user must have enabled them.
    const row = { source: 'caldav', read_only: false, dav_mode: 'read_write', source_access: 'read_write', user_access: 'read_write' };
    const withoutWrites = registryWith(registration({ key: 'caldav', source: 'caldav', features: ['calendars'], writeThrough: false }));
    const withWrites = registryWith(registration({ key: 'caldav', source: 'caldav', features: ['calendars'], writeThrough: true }));

    expect(resolveCollectionAccess(row, { feature: 'calendars', operation: 'update' }, { registry: withoutWrites }).allowed).toBe(false);
    expect(resolveCollectionAccess(row, { feature: 'calendars', operation: 'update' }, { registry: withWrites }).allowed).toBe(true);
  });

  it('does not make a collection writable just because its adapter learned to write', () => {
    // The plan's rule: a read-only collection stays read-only once writes exist. The user's opt-in is a
    // separate gate, and an absent one is a pre-0112 row that could only have meant "not enabled".
    const registry = registryWith(registration({ key: 'microsoft_graph', source: 'microsoft', features: ['contacts'], writeThrough: true }));
    for (const row of [
      { source: 'microsoft', dav_mode: 'read_write' },
      { source: 'microsoft', dav_mode: 'read_write', source_access: 'read_write', user_access: 'source' },
    ]) {
      const access = resolveCollectionAccess(row, { feature: 'contacts', operation: 'create' }, { registry });
      expect(access.allowed).toBe(false);
      expect(access.reasonCode).toBe('COLLECTION_READ_ONLY');
    }
    // And the origin's own refusal cannot be overridden by the user's choice.
    const refusedBySource = resolveCollectionAccess(
      { source: 'microsoft', dav_mode: 'read_write', source_access: 'read_only', user_access: 'read_write' },
      { feature: 'contacts', operation: 'create' },
      { registry },
    );
    expect(refusedBySource.allowed).toBe(false);
    expect(refusedBySource.reasonCode).toBe('COLLECTION_READ_ONLY');
  });

  it('changes the decision per operation when the adapter declares a conflict protection', () => {
    const registry = registryWith(registration({
      key: 'caldav', source: 'caldav', features: ['calendars'], writeThrough: true,
      conflictProtection: { ...ALL_ATOMIC, update: 'unsupported' },
    }));
    const row = { source: 'caldav', read_only: false, dav_mode: 'read_write', source_access: 'read_write', user_access: 'read_write' };

    expect(resolveCollectionAccess(row, { feature: 'calendars', operation: 'create' }, { registry }).allowed).toBe(true);
    const update = resolveCollectionAccess(row, { feature: 'calendars', operation: 'update' }, { registry });
    expect(update.allowed).toBe(false);
    expect(update.reasonCode).toBe('OPERATION_FORBIDDEN');
  });

  it('does not let one feature borrow another adapter of the same origin', () => {
    // A Google mailbox transport is registered for mail; it must not make a Google
    // calendar writable.
    const registry = registryWith(registration({ key: 'gmail_api', source: 'google', features: ['mail'], writeThrough: true }));
    const access = resolveCollectionAccess({ source: 'google', read_only: false, dav_mode: 'read_write' }, { feature: 'calendars', operation: 'update' }, { registry });
    expect(access.allowed).toBe(false);
    expect(access.reasonCode).toBe('OPERATION_FORBIDDEN');
  });

  it('refuses an origin no adapter claims, including a string it does not know', () => {
    const registry = registryWith(registration({ key: 'local', source: 'local', features: ['calendars'] }));
    for (const source of ['pop3', 'nomad', 'local-ish']) {
      const access = resolveCollectionAccess({ source, read_only: false, dav_mode: 'read_write' }, { feature: 'calendars', operation: 'read' }, { registry });
      expect(access.allowed, source).toBe(false);
      expect(access.providerKey, source).toBeNull();
    }
  });

  it('treats an absent source as the database default, local', () => {
    const registry = registryWith(registration({ key: 'local', source: 'local', features: ['calendars'] }));
    const access = resolveCollectionAccess({ read_only: false, dav_mode: 'read_write' }, { feature: 'calendars', operation: 'update' }, { registry });
    expect(access.allowed).toBe(true);
  });

  it('refuses a mutation of a read-only collection with its own reason code', () => {
    const registry = registryWith(registration({ key: 'local', source: 'local', features: ['calendars'] }));
    const access = resolveCollectionAccess({ source: 'local', read_only: true, dav_mode: 'read_write' }, { feature: 'calendars', operation: 'update' }, { registry });
    expect(access.allowed).toBe(false);
    expect(access.reasonCode).toBe('COLLECTION_READ_ONLY');
  });
});

describe('the DAV channel narrows but never widens', () => {
  const local = registryWith(registration({ key: 'local', source: 'local', features: ['calendars'] }));
  const row = { source: 'local', read_only: false, dav_mode: 'read_write' };

  it('refuses a write through a read-only device password', () => {
    const access = resolveCollectionAccess(row, { feature: 'calendars', operation: 'update', channel: 'dav', credentialMaxMode: 'read_only' }, { registry: local });
    expect(access.allowed).toBe(false);
    expect(access.reasonCode).toBe('COLLECTION_READ_ONLY');
    expect(access.effectiveDavMode).toBe('read_only');
  });

  it('refuses a write to a read-only DAV collection even with a read-write password', () => {
    const access = resolveCollectionAccess({ ...row, dav_mode: 'read_only' }, { feature: 'calendars', operation: 'update', channel: 'dav', credentialMaxMode: 'read_write' }, { registry: local });
    expect(access.allowed).toBe(false);
    expect(access.effectiveDavMode).toBe('read_only');
  });

  it('refuses a DAV write when the collection is switched off, and keeps the web path independent of that switch', () => {
    const off = { ...row, dav_mode: 'off' };
    const dav = resolveCollectionAccess(off, { feature: 'calendars', operation: 'update', channel: 'dav', credentialMaxMode: 'read_write' }, { registry: local });
    expect(dav.allowed).toBe(false);
    expect(dav.effectiveDavMode).toBe('off');
    // `dav_mode` is about sharing over DAV, not about the collection's editability.
    expect(resolveCollectionAccess(off, { feature: 'calendars', operation: 'update' }, { registry: local }).allowed).toBe(true);
  });

  it('downgrades a read-write collection to read-only when the adapter cannot write through', () => {
    const remote = registryWith(registration({ key: 'carddav', source: 'carddav', features: ['contacts'], writeThrough: false }));
    const access = resolveCollectionAccess({ source: 'carddav', dav_mode: 'read_write' }, { feature: 'contacts', operation: 'update', channel: 'dav', credentialMaxMode: 'read_write' }, { registry: remote });
    expect(access.effectiveDavMode).toBe('read_only');
    expect(access.allowed).toBe(false);
  });
});

describe('the convenience predicates and refusal message', () => {
  it('agree with the full decision for the registry the application uses', () => {
    const writable = { source: 'local', dav_mode: 'read_write' };
    expect(collectionIsWritable(writable, 'contacts')).toBe(true);
    expect(collectionDavWritable(writable, 'contacts', 'read_write')).toBe(true);
    expect(collectionDavWritable(writable, 'contacts', 'read_only')).toBe(false);
    const remote = { source: 'carddav', dav_mode: 'read_write' };
    expect(collectionIsWritable(remote, 'contacts')).toBe(false);
  });

  it('names the source, not the local read-only flag, for a refused DAV write', () => {
    const registry = registryWith(registration({ key: 'local', source: 'local', features: ['calendars'] }));
    const blocked = resolveCollectionAccess({ source: 'google', read_only: false, dav_mode: 'read_write' }, { feature: 'calendars', operation: 'update', channel: 'dav', credentialMaxMode: 'read_write' }, { registry });
    expect(davWriteRefusalMessage(blocked, 'calendar')).toContain('written by its source');

    const readOnly = resolveCollectionAccess({ source: 'local', read_only: true, dav_mode: 'read_write' }, { feature: 'calendars', operation: 'update', channel: 'dav', credentialMaxMode: 'read_write' }, { registry });
    expect(davWriteRefusalMessage(readOnly, 'calendar')).toContain('read-only');
  });

  it('normalises an absent or unknown DAV mode to the pre-0105 default', () => {
    expect(normalizeDavMode(undefined)).toBe('read_write');
    expect(normalizeDavMode('nonsense')).toBe('read_write');
    expect(normalizeDavMode('off')).toBe('off');
  });
});

describe('the default registry describes what this build can do', () => {
  it('claims write-through only for the adapters that implement it', () => {
    // Graph forwards mail, contact and calendar-event writes, so it declares write-through. A mutation of
    // a pulled Graph collection is still refused, but for the collection's own reason (nobody enabled it)
    // rather than because no write path exists.
    const optedIn = { source: 'microsoft', dav_mode: 'read_write', source_access: 'read_write', user_access: 'read_write' } as const;
    const graph = resolveCollectionAccess(optedIn, { feature: 'contacts', operation: 'create' });
    expect(graph.providerKey).toBe('microsoft_graph');
    expect(graph.allowed).toBe(true);

    const notOptedIn = resolveCollectionAccess({ source: 'microsoft', dav_mode: 'read_write' }, { feature: 'contacts', operation: 'create' });
    expect(notOptedIn.allowed).toBe(false);
    expect(notOptedIn.reasonCode).toBe('COLLECTION_READ_ONLY');

    // CalDAV and CardDAV forward a write through the P10 client, so an opted-in collection of either
    // origin is accepted; google_api still has no write path and refuses whatever the collection says.
    for (const [source, feature] of [['caldav', 'calendars'], ['carddav', 'contacts']] as const) {
      const access = resolveCollectionAccess(
        { source, dav_mode: 'read_write', source_access: 'read_write', user_access: 'read_write' },
        { feature, operation: 'create' },
      );
      expect(access.allowed, source).toBe(true);
      expect(access.providerKey, source).toBe(source);
    }
    const google = resolveCollectionAccess(
      { source: 'google', dav_mode: 'read_write', source_access: 'read_write', user_access: 'read_write' },
      { feature: 'calendars', operation: 'create' },
    );
    expect(google.allowed).toBe(false);
    expect(google.reasonCode).toBe('OPERATION_FORBIDDEN');
  });

  it('keeps a local address book writable', () => {
    expect(collectionIsWritable({ source: 'local' }, 'contacts')).toBe(true);
  });
});
