import { query } from './db.js';
import { classifyProviderAccount, providerConnectionSignals, type ProviderAccountKind } from './providerAccountClassifier.js';
import { listSubscriptionDiagnostics } from './providerPushSubscriptions.js';
import { readProviderFeatureAuthorization, type ProviderFeatureAuthorization } from './providerFeatureAuthorization.js';

/**
 * What one **account** can do with its provider: the mail transport it uses and whether the native one is
 * available, and the state of its calendar, contacts and push.
 *
 * This is the account-centric view the interface needs. A provider connection is a user's authorization for a
 * specific mailbox — `provider_connections.provider_user_id` equals `email_accounts.email_address` — so the
 * features are resolved by **identity**, never by which connection happens to be newest. That is what makes
 * "connect Google Calendar" appear on the Gmail account card rather than somewhere in Integrations.
 */

export interface AccountMailFeatures extends ProviderFeatureAuthorization {
  transport: string;
  /** The transport this account would move to, when a migration applies. */
  nativeTransport: 'gmail_api' | 'microsoft_graph' | null;
  /** Whether the account is already on it. */
  native: boolean;
  /** Whether a migration is offered at all (the account classifies as that provider and is still legacy). */
  migrationAvailable: boolean;
}

export interface AccountFeatureGroup extends ProviderFeatureAuthorization {
  provider: ProviderAccountKind;
  connectionId: string | null;
  collections: Array<{ id: string; kind: string; name: string | null; enabled: boolean; sourceAccess: string; userAccess: string }>;
}

export interface AccountPushFeatures {
  mail: string;
  calendar: string;
  contacts: string;
}

export interface AccountProviderFeatures {
  accountId: string;
  provider: ProviderAccountKind | null;
  mail: AccountMailFeatures;
  calendar: AccountFeatureGroup | null;
  contacts: AccountFeatureGroup | null;
  push: AccountPushFeatures;
}

const NATIVE_TRANSPORT: Record<ProviderAccountKind, 'gmail_api' | 'microsoft_graph'> = {
  google: 'gmail_api',
  microsoft: 'microsoft_graph',
};

/**
 * The connection authorizing this mailbox for one provider, matched on the verified identity.
 *
 * A user can hold several connections (a mail grant, a contacts grant, a calendar grant); picking one by
 * creation order would attach the wrong collections to the account, so the match is the verified address.
 */
export async function connectionForAccount(input: {
  userId: string;
  address: string | null;
  provider: ProviderAccountKind;
}): Promise<{ id: string; providerUserId: string | null } | null> {
  const address = (input.address ?? '').trim();
  if (!address) return null;
  const result = await query<{ id: string; provider_user_id: string | null }>(
    `SELECT id, provider_user_id FROM provider_connections
      WHERE user_id = $1 AND provider = $2 AND status = 'active'
        AND lower(COALESCE(provider_user_id, '')) = lower($3)
      ORDER BY created_at DESC LIMIT 1`,
    [input.userId, input.provider, address],
  );
  const row = result.rows[0];
  return row ? { id: row.id, providerUserId: row.provider_user_id } : null;
}

async function collectionsFor(connectionId: string | null): Promise<AccountFeatureGroup['collections']> {
  if (!connectionId) return [];
  const result = await query<{
    id: string; kind: string; name: string | null; enabled: boolean;
    source_access: string | null; user_access: string | null;
  }>(
    `SELECT ic.id, ic.kind, COALESCE(c.name, ab.name) AS name, ic.enabled, ic.source_access, ic.user_access
       FROM integration_collections ic
       LEFT JOIN calendars c ON c.id = ic.local_calendar_id
       LEFT JOIN address_books ab ON ab.id = ic.local_address_book_id
      WHERE ic.connection_id = $1
      ORDER BY ic.kind, ic.created_at`,
    [connectionId],
  );
  return result.rows.map(row => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled,
    sourceAccess: row.source_access ?? 'read_only',
    userAccess: row.user_access ?? 'source',
  }));
}

/** The push state that belongs to this account's own subscriptions. */
function pushStateFor(input: {
  provider: ProviderAccountKind;
  connectionId: string | null;
  mailNative: boolean;
  subscriptions: Array<{ connectionId: string; resourceType: string; status: string }>;
}): AccountPushFeatures {
  const forConnection = input.subscriptions.filter(row => row.connectionId === input.connectionId);
  const state = (resourceType: string, fallback: string) => {
    const row = forConnection.find(subscription => subscription.resourceType === resourceType);
    return row ? row.status : fallback;
  };
  return {
    // Mail push exists only with the native transport; the legacy one has no provider notification to give.
    mail: input.mailNative ? state('mail', 'available') : 'unavailable_until_native',
    calendar: state('calendar', 'disabled'),
    // The People API has no push channel for the resources Inboxora syncs, so contacts stay on the schedule.
    contacts: 'polling',
  };
}

export async function describeAccountProviderFeatures(input: {
  userId: string;
  accountId: string;
}): Promise<AccountProviderFeatures | null> {
  const account = await query<{
    id: string; email_address: string | null; imap_host: string | null; oauth_provider: string | null;
    mail_transport: string | null;
  }>(
    `SELECT id, email_address, imap_host, oauth_provider, mail_transport FROM email_accounts
      WHERE id = $1 AND user_id = $2`,
    [input.accountId, input.userId],
  );
  const row = account.rows[0];
  if (!row) return null;

  const connections = await providerConnectionSignals(input.userId);
  const provider = classifyProviderAccount({ ...row, connections });
  const transport = row.mail_transport ?? 'imap_smtp';
  const nativeTransport = provider ? NATIVE_TRANSPORT[provider] : null;
  const native = nativeTransport !== null && transport === nativeTransport;
  const subscriptions = await listSubscriptionDiagnostics();

  const groups = {} as Record<ProviderAccountKind, AccountFeatureGroup>;
  const contactsAuth = {} as Partial<Record<ProviderAccountKind, ProviderFeatureAuthorization>>;
  const mailConnection = provider
    ? await connectionForAccount({ userId: input.userId, address: row.email_address, provider })
    : null;
  const mailAuth = provider
    ? await readProviderFeatureAuthorization({ connectionId: mailConnection?.id ?? null, provider, feature: 'mail' })
    : { authorized: false, requiredScopes: [], grantedScopes: [], missingScopes: [] };

  for (const kind of ['google', 'microsoft'] as const) {
    const connection = await connectionForAccount({ userId: input.userId, address: row.email_address, provider: kind });
    const calendarAuth = await readProviderFeatureAuthorization({ connectionId: connection?.id ?? null, provider: kind, feature: 'calendar' });
    contactsAuth[kind] = await readProviderFeatureAuthorization({ connectionId: connection?.id ?? null, provider: kind, feature: 'contacts' });
    groups[kind] = {
      provider: kind,
      connectionId: connection?.id ?? null,
      collections: await collectionsFor(connection?.id ?? null),
      ...calendarAuth,
    };
  }

  return {
    accountId: row.id,
    provider,
    mail: {
      transport,
      nativeTransport,
      native,
      ...mailAuth,
      // A migration is offered only for an account that classifies as the provider and is not already native.
      migrationAvailable: provider !== null && !native,
    },
    calendar: provider ? groups[provider] : null,
    contacts: provider ? { ...groups[provider], ...(contactsAuth[provider] ?? { authorized: false, requiredScopes: [], grantedScopes: [], missingScopes: [] }) } : null,
    push: pushStateFor({
      provider: provider ?? 'google',
      connectionId: provider ? groups[provider].connectionId : null,
      mailNative: native,
      subscriptions: subscriptions.map(subscription => ({
        connectionId: subscription.connectionId,
        resourceType: subscription.resourceType,
        status: subscription.status,
      })),
    }),
  };
}
