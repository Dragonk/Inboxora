import { PROVIDER_OPERATIONS } from './contracts.js';
import type {
  ConflictProtection,
  IntegrationFeature,
  MailTransport,
  ProviderDescriptor,
  ProviderOperation,
  SourceKind,
} from './contracts.js';

/**
 * Adapter identity. Mail is keyed by its transport; calendars/contacts by the
 * resource kind. `local` is Inboxora's own store.
 */
export type ProviderKey =
  | 'local'
  | MailTransport
  | 'google_api'
  | 'caldav'
  | 'carddav'
  | 'ical_url';

export interface ProviderRegistration extends ProviderDescriptor {
  readonly key: ProviderKey;
  readonly source?: SourceKind;
}

export class ProviderRegistryError extends Error {}

function isProviderKey(value: unknown): value is ProviderKey {
  return value === 'local' || value === 'imap_smtp' || value === 'microsoft_graph'
    || value === 'gmail_api' || value === 'google_api' || value === 'caldav'
    || value === 'carddav' || value === 'ical_url';
}

function isConflictProtection(value: unknown): value is ConflictProtection {
  return value === 'atomic' || value === 'best_effort' || value === 'unsupported';
}

function isFeature(value: unknown): value is IntegrationFeature {
  return value === 'mail' || value === 'calendars' || value === 'contacts';
}

function validate(registration: ProviderRegistration): void {
  if (!isProviderKey(registration.key)) throw new ProviderRegistryError(`Unknown provider key: ${String(registration.key)}`);
  if (registration.features.length === 0) throw new ProviderRegistryError(`Provider ${registration.key} declares no features`);
  for (const feature of registration.features) {
    if (!isFeature(feature)) throw new ProviderRegistryError(`Provider ${registration.key} declares an unknown feature: ${String(feature)}`);
  }
  for (const operation of PROVIDER_OPERATIONS) {
    if (!isConflictProtection(registration.conflictProtection[operation])) {
      throw new ProviderRegistryError(`Provider ${registration.key} is missing conflict protection for ${operation}`);
    }
  }
}

/**
 * Registry of protocol adapters. It only carries declared support; the actual
 * adapters register here so a command service can gate an operation before it
 * runs and surface a precise reason instead of assuming all operations exist.
 */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderKey, ProviderRegistration>();

  register(registration: ProviderRegistration): this {
    validate(registration);
    if (this.providers.has(registration.key)) {
      throw new ProviderRegistryError(`Provider already registered: ${registration.key}`);
    }
    this.providers.set(registration.key, Object.freeze({ ...registration, features: Object.freeze([...registration.features]) }));
    return this;
  }

  get(key: ProviderKey): ProviderRegistration | undefined {
    return this.providers.get(key);
  }

  /** Descriptor for a mail transport, when one is registered. */
  forMailTransport(transport: MailTransport): ProviderRegistration | undefined {
    return this.providers.get(transport);
  }

  supports(key: ProviderKey, feature: IntegrationFeature): boolean {
    return this.providers.get(key)?.features.includes(feature) ?? false;
  }

  /**
   * The adapter that owns a resource kind for a collection origin. A `source`
   * column can be served by more than one adapter (Google's mail transport and
   * its People/Calendar API are separate registrations), so the lookup is by
   * origin **and** feature rather than by origin alone.
   */
  forSource(source: SourceKind, feature: IntegrationFeature): ProviderRegistration | undefined {
    return this.list().find(provider => provider.source === source && provider.features.includes(feature));
  }

  conflictProtectionFor(key: ProviderKey, operation: ProviderOperation): ConflictProtection {
    return this.providers.get(key)?.conflictProtection[operation] ?? 'unsupported';
  }

  list(): readonly ProviderRegistration[] {
    return [...this.providers.values()];
  }
}

function protections(overrides: Partial<Record<ProviderOperation, ConflictProtection>> = {}): Readonly<Record<ProviderOperation, ConflictProtection>> {
  const base: Record<ProviderOperation, ConflictProtection> = {
    read: 'atomic', create: 'atomic', update: 'atomic', delete: 'atomic', rsvp: 'best_effort', send: 'unsupported',
  };
  return Object.freeze({ ...base, ...overrides });
}

/**
 * Descriptors for the transports the product supports. The values state what
 * each protocol can actually guarantee; a missing capability must be surfaced
 * to the user rather than silently downgraded.
 *
 * `writeThrough` means **this build's adapter forwards a mutation to the
 * collection's origin**. It is therefore false both for an import/read-only
 * source and for an adapter whose write path does not exist yet — a registration
 * must not advertise a write it cannot perform, because the capability resolver
 * (and through it every REST and DAV write guard) trusts this field. Flipping it
 * to `true` is the last step of implementing that adapter's mutations, not the
 * first. `local` is the origin itself, so its writes are accepted locally and
 * are recognised by `source === 'local'` rather than by this flag.
 */
export const DEFAULT_PROVIDER_REGISTRATIONS: readonly ProviderRegistration[] = Object.freeze([
  {
    key: 'local',
    source: 'local',
    features: ['mail', 'calendars', 'contacts'],
    writeThrough: false,
    conflictProtection: protections({ send: 'unsupported' }),
  },
  {
    key: 'imap_smtp',
    mailTransport: 'imap_smtp',
    source: 'local',
    features: ['mail'],
    writeThrough: true,
    // IMAP mutations have no server-side precondition; send over SMTP has none.
    conflictProtection: protections({ create: 'best_effort', update: 'best_effort', delete: 'best_effort', rsvp: 'unsupported', send: 'unsupported' }),
  },
  {
    key: 'microsoft_graph',
    mailTransport: 'microsoft_graph',
    source: 'microsoft',
    features: ['mail', 'calendars', 'contacts'],
    // Graph writes exist for mail (P07b: flags, move, delete), contacts and calendar events (P09), so a
    // mutation is forwarded to Microsoft. This does **not** make a pulled collection writable by itself:
    // the collection must also say the origin permits writes (`source_access`) and the user must have
    // enabled them (`user_access`), which is the capability model's fourth layer.
    writeThrough: true,
    // Graph contacts do not document a conditional header on every mutation.
    conflictProtection: protections({ delete: 'best_effort' }),
  },
  {
    key: 'gmail_api',
    mailTransport: 'gmail_api',
    source: 'google',
    features: ['mail'],
    // Read only in this build: the Gmail transport (P08) is not implemented.
    writeThrough: false,
    // Gmail has no version precondition and `deleteContact`-style calls lack CAS.
    conflictProtection: protections({ update: 'best_effort', delete: 'unsupported', rsvp: 'unsupported' }),
  },
  {
    key: 'google_api',
    source: 'google',
    features: ['calendars', 'contacts'],
    // The People/Calendar adapters forward create/update/delete (P09) through the shared mutation journal,
    // so a mutation is sent to Google. As with Graph this does **not** make a pulled collection writable by
    // itself: the collection must also say the origin permits writes (`source_access`) and the user must have
    // opted in (`user_access`), which is the capability model's fourth layer. The Google sync records the
    // provider's own answer — a calendar's `accessRole` (`owner`/`writer` are writable) and, for contacts,
    // the People API's permission for the user's own contacts — so the switch is offered exactly where Google
    // permits a write and refused for a calendar shared read-only. The adapter is behind the gate, not around
    // it.
    writeThrough: true,
    conflictProtection: protections({ rsvp: 'unsupported' }),
  },
  {
    key: 'caldav',
    source: 'caldav',
    features: ['calendars'],
    // The external CalDAV write-back client (P10) forwards a PUT/DELETE to the collection's own
    // server through the mutation layer, so the adapter can honour the write. It does not make a
    // pulled calendar writable by itself: the collection's own access mode and the device
    // password's ceiling are still applied by the capability resolver.
    writeThrough: true,
    conflictProtection: protections(),
  },
  {
    key: 'carddav',
    source: 'carddav',
    features: ['contacts'],
    // As CalDAV: P10 forwards the write to the CardDAV server the book was imported from.
    writeThrough: true,
    conflictProtection: protections(),
  },
  {
    key: 'ical_url',
    source: 'ical_url',
    features: ['calendars'],
    writeThrough: false,
    // An ICS subscription is read-only: there is no write-back channel.
    conflictProtection: protections({ create: 'unsupported', update: 'unsupported', delete: 'unsupported', rsvp: 'unsupported', send: 'unsupported' }),
  },
]);

export function createDefaultRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const registration of DEFAULT_PROVIDER_REGISTRATIONS) registry.register(registration);
  return registry;
}
