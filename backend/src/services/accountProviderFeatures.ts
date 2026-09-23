import { query } from './db.js';
import { classifyProviderAccount, providerConnectionSignals, type ProviderAccountKind } from './providerAccountClassifier.js';
import { listSubscriptionDiagnostics } from './providerPushSubscriptions.js';
import { providerSyncIntervalMinutes } from './providerSyncScheduler.js';
import { evaluateProviderFeatureAuthorization, readProviderFeatureAuthorization, type ProviderFeatureAuthorization } from './providerFeatureAuthorization.js';
import { accountProviderFeatureSettings } from './accountProviderFeatureSettings.js';

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
  synchronized: boolean;
  syncPending: boolean;
  syncErrorCode: string | null;
  /** The transport this account would move to, when a migration applies. */
  nativeTransport: 'gmail_api' | 'microsoft_graph' | null;
  /** Whether the account is already on it. */
  native: boolean;
  /** Whether a migration is offered at all (the account classifies as that provider and is still legacy). */
  migrationAvailable: boolean;
}

export interface AccountFeatureGroup extends ProviderFeatureAuthorization {
  provider: ProviderAccountKind;
  /** User intent is independent of an OAuth grant and of discovered collections. */
  enabled: boolean;
  settingsRevision: number;
  connectionId: string | null;
  collections: Array<{ id: string; kind: string; name: string | null; enabled: boolean; sourceAccess: string; userAccess: string }>;
  /** A run has completed for this feature. */
  synchronized: boolean;
  /** Authorized, but no completed run yet or the newest result is an error. */
  syncPending: boolean;
  /** The last recorded failure, so the interface can distinguish it from "not connected". */
  syncErrorCode: string | null;
}

export interface AccountPushFeatures {
  mail: string;
  calendar: string;
  contacts: string;
}

/**
 * One feature's last recorded run, from the same `sync_states` rows the scheduler and the manual sync write.
 *
 * `cursor` is distilled to a boolean: the interface needs to know whether an incremental sync has somewhere to
 * continue from, and the cursor itself is a provider history id that belongs to the sync, not to a screen.
 */
export interface AccountFeatureSyncState {
  lastSuccessfulSync: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  cursorPresent: boolean;
  /** The `sync_states.coverage` this feature's own pipeline writes, which is what the fields above describe. */
  syncStateCoverage: string;
  /**
   * Whether the scheduler would pick this feature up: a connection reaches it through an enabled collection of
   * the right kind linked to a local folder, calendar or address book. A feature that is authorized but not a
   * target is refreshed only by a manual synchronisation, which is worth knowing without reading the database.
   */
  schedulerTarget: boolean;
}

/**
 * Push, in the three parts that are actually different things.
 *
 * `available` is a capability — the provider offers a notification channel for this resource. It says nothing
 * about whether one is subscribed, which is what a user reads "Push: available" as. The subscription is its own
 * state, and the effective mode is what the mailbox is really doing: push **and** polling, or polling alone.
 * Polling is never disabled by an absent subscription, so an installation without Pub/Sub or a webhook still
 * receives mail on the schedule.
 */
export interface AccountPushModel {
  capability: 'available' | 'unavailable';
  /**
   * The subscription's own state. Every status a subscription row can hold is reported as itself: collapsing
   * `renewing`, `failed` and `removed` into `missing` hid a subscription that exists but is not delivering,
   * which is exactly the state a user must not read as "push is fine" (OBS-03).
   */
  subscription: 'active' | 'disabled' | 'expired' | 'renewing' | 'failed' | 'removed' | 'missing' | 'not_configured';
  effectiveSyncMode: 'push_and_polling' | 'polling';
  /** Why push is not doing what `capability` suggests, or null when nothing is degraded. */
  degradedReason: string | null;
  /** The subscription's own bookkeeping, so the card can say when a renewal is due. */
  expiresAt: string | null;
  lastNotificationAt: string | null;
  /** The provider's error code from the last failed renewal, if any. */
  lastErrorCode: string | null;
}

export interface AccountDiagnostics {
  connection: { provider: ProviderAccountKind; identity: string | null; status: string } | null;
  push: { mail: AccountPushModel; calendar: AccountPushModel; contacts: AccountPushModel };
  mail: AccountFeatureSyncState & {
    transport: string;
    authorized: boolean;
    requiredScopes: string[];
    missingScopes: string[];
    push: string;
    scheduler: string;
  };
  calendar: AccountFeatureSyncState & {
    authorized: boolean;
    requiredScopes: string[];
    missingScopes: string[];
    collections: number;
    push: string;
  };
  contacts: AccountFeatureSyncState & {
    authorized: boolean;
    requiredScopes: string[];
    missingScopes: string[];
    collections: number;
    push: string;
  };
}

export interface AccountProviderFeatures {
  accountId: string;
  provider: ProviderAccountKind | null;
  mail: AccountMailFeatures;
  calendar: AccountFeatureGroup | null;
  contacts: AccountFeatureGroup | null;
  push: AccountPushFeatures;
  /**
   * The same capabilities, plus what the last runs did. Deliberately one request: the diagnostics must not
   * re-derive authorization with their own copy of the scope rules, and they must never carry a token — the
   * capability evaluator reads `oauth_grants.scopes` and its status only.
   */
  diagnostics: AccountDiagnostics;
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
  /** The connection the account itself records, when it has one. */
  linkedConnectionId?: string | null;
}): Promise<{ id: string; providerUserId: string | null } | null> {
  // The account's own link wins. A mailbox that was moved to its provider transport records the connection it
  // was moved with, and that is the identity the user authorized — the verified address is a *fallback*, for
  // the legacy case where no link was ever recorded.
  //
  // Matching on the address alone is what made a live installation read "missing Calendars.ReadWrite" while
  // the grant existed: Microsoft returns the mailbox's primary address as `providerUserId`, so a consent
  // granted while signing in with an alias (or for a mailbox whose primary address differs from the one the
  // account stores) resolved to no connection — or, worse, to a second connection with only that feature's
  // scopes. The subject/issuer identity is the stable one, and the link is how this row refers to it.
  if (input.linkedConnectionId) {
    const linked = await query<{ id: string; provider_user_id: string | null }>(
      `SELECT id, provider_user_id FROM provider_connections
        WHERE id = $1 AND user_id = $2 AND provider = $3 AND status = 'active'`,
      [input.linkedConnectionId, input.userId, input.provider],
    );
    if (linked.rows[0]) return { id: linked.rows[0].id, providerUserId: linked.rows[0].provider_user_id };
  }

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

/**
 * The push model for one resource of one connection.
 *
 * `capability` is the provider's, not the account's: Gmail offers a Pub/Sub notification for mail, Graph offers
 * change notifications for mail, calendars and contacts, and the People API offers none for the contacts this
 * application syncs. `subscription` is read from the subscription row that belongs to this connection and
 * resource, and `effectiveSyncMode` follows from it — an inactive subscription means polling is doing the work.
 */
function pushModelFor(input: {
  capability: 'available' | 'unavailable';
  subscriptions: Array<{
    connectionId: string | null; resourceType: string; status: string;
    expiresAt?: Date | string | null; lastNotificationAt?: Date | string | null; lastErrorCode?: string | null;
  }>;
  connectionId: string | null;
  resourceType: string;
}): AccountPushModel {
  if (input.capability === 'unavailable') {
    return {
      capability: 'unavailable', subscription: 'not_configured', effectiveSyncMode: 'polling',
      degradedReason: 'provider_has_no_channel', expiresAt: null, lastNotificationAt: null, lastErrorCode: null,
    };
  }
  const row = input.subscriptions.find(subscription =>
    subscription.connectionId === input.connectionId && subscription.resourceType === input.resourceType);
  const known = new Set(['active', 'disabled', 'expired', 'renewing', 'failed', 'removed']);
  const subscription: AccountPushModel['subscription'] = row
    ? (known.has(row.status) ? row.status as AccountPushModel['subscription'] : 'missing')
    : 'missing';
  // A subscription that is not active says *why* it is not, so the card cannot render "available" for a channel
  // that is not delivering (OBS-03).
  const degradedReason = subscription === 'active' ? null
    : subscription === 'missing' ? 'not_subscribed'
      : `subscription_${subscription}`;
  return {
    capability: 'available',
    subscription,
    // The schedule always runs; an active subscription adds the immediate notification on top of it.
    effectiveSyncMode: subscription === 'active' ? 'push_and_polling' : 'polling',
    degradedReason,
    expiresAt: toIsoOrNull(row?.expiresAt),
    lastNotificationAt: toIsoOrNull(row?.lastNotificationAt),
    lastErrorCode: row?.lastErrorCode ?? null,
  };
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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

/**
 * The synchronization half of a feature's state, derived once and used by both the feature groups and the
 * diagnostics.
 *
 * Authorization and synchronization are separate facts, and conflating them is what made a card say "not
 * connected" for an account whose grant was stored and whose first sync had failed. `synchronized` means a run
 * completed, `syncPending` means one is due or in flight (a grant exists but nothing has been recorded yet),
 * and `syncErrorCode` carries the last failure so the interface can say "connected, synchronisation failed"
 * rather than either lie.
 */
export function synchronizationStateOf(state: AccountFeatureSyncState | undefined, authorized: boolean): {
  synchronized: boolean;
  syncPending: boolean;
  syncErrorCode: string | null;
} {
  const sync = state ?? EMPTY_SYNC_STATE;
  const synchronized = sync.lastSuccessfulSync !== null;
  return {
    synchronized,
    // Pending means: authorized, and either no run has finished or the newest result is an error that has not
    // been superseded by a success. A feature that is not authorized is simply not connected.
    syncPending: authorized && (!synchronized || sync.lastErrorCode !== null),
    syncErrorCode: sync.lastErrorCode ?? null,
  };
}

/**
 * Fill in the two facts that say how this state is arrived at: the coverage it was read from, and whether the
 * scheduler would refresh the feature by itself.
 *
 * A feature can be authorized and not a scheduler target — its collection has no local link, or the provider
 * has no collection for it at all — and then only a manual synchronisation refreshes it. Reporting that is what
 * turns "last synchronised: never" into an answer instead of a mystery.
 */
function withSchedulerTarget(
  state: AccountFeatureSyncState,
  feature: 'mail' | 'calendar' | 'contacts',
  schedulable: Set<string>,
  authorized: boolean,
  provider: ProviderAccountKind | null,
): AccountFeatureSyncState & { synchronized: boolean; syncPending: boolean; syncErrorCode: string | null } {
  const coverage = PIPELINE_COVERAGE[feature]!;
  const kinds = feature === 'mail' ? ['mail_label', 'mail_folder'] : [feature === 'calendar' ? 'calendar' : 'address_book'];
  return {
    ...state,
    // The pipeline's own coverage is what the fields above describe; discovery has its own row and is not it.
    // The name depends on the provider (Gmail records `history`, Graph records `messages`), so it is read from
    // the provider that owns the feature rather than always from the Google entry (OBS-01).
    syncStateCoverage: provider ? coverage[provider] : '',
    schedulerTarget: authorized && kinds.some(kind => schedulable.has(kind)),
    ...synchronizationStateOf(state, authorized),
  };
}

const EMPTY_SYNC_STATE: AccountFeatureSyncState = {
  lastSuccessfulSync: null,
  lastErrorCode: null,
  lastErrorAt: null,
  cursorPresent: false,
  syncStateCoverage: '',
  schedulerTarget: false,
};

/**
 * The `sync_states.coverage` that represents each feature's real pipeline.
 *
 * A feature writes more than one kind of run: Gmail's label discovery records `labels` and its message/history
 * pipeline records `history`; Graph's folder discovery records `folders` and its messages record `messages`.
 * Reading "the newest row for the feature" therefore let a *discovery* run be reported as a successful mail
 * synchronisation — the live report was `lastSuccessfulSync` set with `cursorPresent = false`, which is
 * exactly a label run with no history cursor behind it. The pipeline's own coverage is what the diagnostics
 * read, so discovery can never stand in for synchronisation.
 */
const PIPELINE_COVERAGE: Record<string, { google: string; microsoft: string }> = {
  mail: { google: 'history', microsoft: 'messages' },
  calendar: { google: 'events', microsoft: 'events' },
  contacts: { google: 'personal', microsoft: 'personal' },
};

/** The last recorded run of each feature's own pipeline for one account, read from `sync_states`. */
async function syncStatesForAccount(
  userId: string,
  accountId: string,
  connectionId: string | null,
): Promise<Record<string, AccountFeatureSyncState>> {
  const pipelineCoverages = [...new Set(Object.values(PIPELINE_COVERAGE).flatMap(entry => [entry.google, entry.microsoft]))];
  // OBS-01: mail states are written per account, while calendar and contacts states are written per connection
  // and per collection with no account id at all (`ensureSyncState` is called without one), and the calendar
  // writer spells the feature `calendars`. Filtering everything by `account_id` therefore matched only mail, and
  // grouping by the raw feature name dropped the calendar rows, so the card said "never" for a mailbox that had
  // synchronized. The scope now follows how each feature is actually stored, and the feature name is normalised.
  const result = await query<{
    feature: string; coverage: string; last_success_at: Date | string | null;
    last_error_code: string | null; last_error_at: Date | string | null; cursor_present: boolean;
  }>(
    `SELECT CASE WHEN feature = 'calendars' THEN 'calendar' ELSE feature END AS feature,
            coverage,
            max(last_success_at) AS last_success_at,
            (array_agg(last_error_code ORDER BY last_error_at DESC NULLS LAST))[1] AS last_error_code,
            max(last_error_at) AS last_error_at,
            bool_or(cursor IS NOT NULL) AS cursor_present
       FROM sync_states
      WHERE user_id = $1
        AND coverage = ANY($4::text[])
        AND (
          (feature = 'mail' AND account_id = $2)
          OR (feature IN ('calendar', 'calendars', 'contacts') AND $3::uuid IS NOT NULL AND connection_id = $3)
        )
      GROUP BY CASE WHEN feature = 'calendars' THEN 'calendar' ELSE feature END, coverage`,
    [userId, accountId, connectionId, pipelineCoverages],
  );
  const states: Record<string, AccountFeatureSyncState> = {};
  for (const row of result.rows) {
    const expected = PIPELINE_COVERAGE[row.feature];
    // Only the pipeline's own coverage counts; a discovery row is deliberately ignored.
    if (!expected || (row.coverage !== expected.google && row.coverage !== expected.microsoft)) continue;
    const previous = states[row.feature];
    const candidate: AccountFeatureSyncState = {
      // An absent time is reported as null rather than invented, so the interface can say "never".
      lastSuccessfulSync: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
      lastErrorCode: row.last_error_code ?? null,
      lastErrorAt: row.last_error_at ? new Date(row.last_error_at).toISOString() : null,
      cursorPresent: Boolean(row.cursor_present),
      syncStateCoverage: row.coverage,
      schedulerTarget: false,
    };
    // Both providers can only have one of the two coverages, but a mailbox moved between them may have both;
    // the newest completed run wins, and a recorded error survives if the newer row has none.
    if (!previous || (candidate.lastSuccessfulSync ?? '') > (previous.lastSuccessfulSync ?? '')) {
      states[row.feature] = {
        ...candidate,
        lastErrorCode: candidate.lastErrorCode ?? previous?.lastErrorCode ?? null,
      };
    }
  }
  return states;
}

/**
 * The connection this mailbox currently has for its provider, whatever its status.
 *
 * The feature groups only ever consider `active` connections, because only those can authorize a call. The
 * diagnostics have to show a revoked one, since "it was disconnected" is the answer a failing sync needs.
 */
async function connectionDiagnosticForAccount(input: {
  userId: string;
  address: string | null;
  provider: ProviderAccountKind;
}): Promise<AccountDiagnostics['connection']> {
  const address = (input.address ?? '').trim();
  if (!address) return null;
  const result = await query<{ provider_user_id: string | null; status: string | null }>(
    `SELECT provider_user_id, status FROM provider_connections
      WHERE user_id = $1 AND provider = $2 AND lower(COALESCE(provider_user_id, '')) = lower($3)
      ORDER BY created_at DESC LIMIT 1`,
    [input.userId, input.provider, address],
  );
  const row = result.rows[0];
  return row ? { provider: input.provider, identity: row.provider_user_id, status: row.status ?? 'unknown' } : null;
}

export async function describeAccountProviderFeatures(input: {
  userId: string;
  accountId: string;
}): Promise<AccountProviderFeatures | null> {
  const account = await query<{
    id: string; email_address: string | null; imap_host: string | null; oauth_provider: string | null;
    mail_transport: string | null; provider_connection_id: string | null;
  }>(
    `SELECT id, email_address, imap_host, oauth_provider, mail_transport, provider_connection_id FROM email_accounts
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

  // The verified connection this account resolves to. It scopes both the synchronization states and the
  // scheduler-target question: calendar and address-book collections are stored per connection, with no
  // account id, so an account-scoped query cannot see them (OBS-01).
  const mailConnection = provider
    ? await connectionForAccount({
        userId: input.userId, address: row.email_address, provider,
        linkedConnectionId: row.provider_connection_id,
      })
    : null;
  const mailAuth = provider
    ? await readProviderFeatureAuthorization({ connectionId: mailConnection?.id ?? null, provider, feature: 'mail' })
    : evaluateProviderFeatureAuthorization('google', 'mail', []);

  // Read once, before the groups are assembled: each group reports its own synchronization state.
  const syncStates = await syncStatesForAccount(input.userId, row.id, mailConnection?.id ?? null);
  const serviceSettings = new Map((await accountProviderFeatureSettings(row.id)).map(setting => [setting.feature, setting]));
  // Which collection kinds the scheduler would pick up for this account's connection. The scheduler's own query
  // requires an enabled collection with a local link on the connection, so this asks the same question of the
  // same table: mail collections are account-scoped, calendar and address-book ones connection-scoped.
  const schedulableKinds = await query<{ kind: string }>(
    `SELECT DISTINCT ic.kind
       FROM integration_collections ic
      WHERE ic.user_id = $1 AND ic.enabled = true
        AND (ic.local_calendar_id IS NOT NULL OR ic.local_address_book_id IS NOT NULL OR ic.local_folder_id IS NOT NULL)
        AND (
          (ic.kind IN ('mail_label', 'mail_folder') AND ic.account_id = $2)
          OR (ic.kind IN ('calendar', 'address_book') AND $3::uuid IS NOT NULL
              AND (ic.connection_id = $3 OR ic.source_connection_id = $3))
        )`,
    [input.userId, row.id, mailConnection?.id ?? null],
  );
  const schedulable = new Set(schedulableKinds.rows.map(entry => entry.kind));
  const groups = {} as Record<ProviderAccountKind, AccountFeatureGroup>;
  const contactsAuth = {} as Partial<Record<ProviderAccountKind, ProviderFeatureAuthorization>>;

  for (const kind of ['google', 'microsoft'] as const) {
    const connection = await connectionForAccount({
      userId: input.userId, address: row.email_address, provider: kind,
      linkedConnectionId: row.provider_connection_id,
    });
    const calendarAuth = await readProviderFeatureAuthorization({ connectionId: connection?.id ?? null, provider: kind, feature: 'calendar' });
    contactsAuth[kind] = await readProviderFeatureAuthorization({ connectionId: connection?.id ?? null, provider: kind, feature: 'contacts' });
    const collections = await collectionsFor(connection?.id ?? null);
    groups[kind] = {
      provider: kind,
      enabled: serviceSettings.get('calendars')?.enabled === true,
      settingsRevision: serviceSettings.get('calendars')?.revision ?? 0,
      connectionId: connection?.id ?? null,
      collections,
      ...calendarAuth,
      // Authorization and synchronization are separate: an authorized feature with a recorded failure reports
      // the failure, never "not connected". A feature with no authorization has no run to report.
      ...(kind === provider
        ? synchronizationStateOf(syncStates.calendar, calendarAuth.authorized)
        : { synchronized: false, syncPending: false, syncErrorCode: null }),
    };
  }

  const connectionDiagnostic = provider
    ? await connectionDiagnosticForAccount({ userId: input.userId, address: row.email_address, provider })
    : null;
  const push = pushStateFor({
    provider: provider ?? 'google',
    connectionId: provider ? groups[provider].connectionId : null,
    mailNative: native,
    subscriptions: subscriptions.map(subscription => ({
      connectionId: subscription.connectionId,
      resourceType: subscription.resourceType,
      status: subscription.status,
    })),
  });
  const subscriptionRows = subscriptions.map(subscription => ({
    connectionId: subscription.connectionId,
    resourceType: subscription.resourceType,
    status: subscription.status,
    expiresAt: subscription.expiresAt,
    lastNotificationAt: subscription.lastNotificationAt,
    lastErrorCode: subscription.lastErrorCode,
  }));
  // One model per resource, computed once: the diagnostics render it and the scheduler label follows it, so the
  // two can never disagree (OBS-03).
  const mailPush = pushModelFor({
    capability: native ? 'available' : 'unavailable', subscriptions: subscriptionRows,
    connectionId: provider ? groups[provider].connectionId : null, resourceType: 'mail',
  });
  const diagnostics: AccountDiagnostics = {
    connection: connectionDiagnostic,
    push: {
      // Mail push exists only with a native transport: the legacy IMAP/SMTP path has no provider notification.
      mail: mailPush,
      calendar: pushModelFor({ capability: provider ? 'available' : 'unavailable', subscriptions: subscriptionRows, connectionId: provider ? groups[provider].connectionId : null, resourceType: 'calendar' }),
      // The People API has no notification channel for the resources this application syncs.
      contacts: pushModelFor({
        capability: provider === 'microsoft' ? 'available' : 'unavailable',
        subscriptions: subscriptionRows,
        connectionId: provider ? groups[provider].connectionId : null,
        resourceType: 'contacts',
      }),
    },
    mail: {
      ...withSchedulerTarget(syncStates.mail ?? EMPTY_SYNC_STATE, 'mail', schedulable, native, provider),
      transport,
      authorized: mailAuth.authorized,
      requiredScopes: mailAuth.requiredScopes,
      missingScopes: mailAuth.missingScopes,
      push: push.mail,
      // The schedule's own state, not an assumption: `scheduled_and_push` is only true when the schedule is
      // enabled *and* a subscription is actually delivering. Reporting it for a native transport with no active
      // subscription is what made "Push: available" appear for a mailbox that only polls (OBS-03).
      scheduler: providerSyncIntervalMinutes() === 0
        ? 'disabled'
        : (native && mailPush.subscription === 'active' ? 'scheduled_and_push' : 'scheduled'),
    },
    calendar: {
      ...withSchedulerTarget(syncStates.calendar ?? EMPTY_SYNC_STATE, 'calendar', schedulable, provider !== null, provider),
      authorized: provider ? groups[provider].authorized : false,
      requiredScopes: provider ? groups[provider].requiredScopes : [],
      missingScopes: provider ? groups[provider].missingScopes : [],
      // Only calendar collections are calendars: counting every collection of the connection reported folders as
      // calendars, which is how "6 collections" appeared next to an empty calendar (OBS-01).
      collections: provider ? groups[provider].collections.filter(collection => collection.kind === 'calendar').length : 0,
      push: push.calendar,
    },
    contacts: {
      ...withSchedulerTarget(syncStates.contacts ?? EMPTY_SYNC_STATE, 'contacts', schedulable, provider !== null, provider),
      authorized: provider ? contactsAuth[provider]?.authorized ?? false : false,
      requiredScopes: provider ? contactsAuth[provider]?.requiredScopes ?? [] : [],
      missingScopes: provider ? contactsAuth[provider]?.missingScopes ?? [] : [],
      // An address book is `kind = 'address_book'`; `'contacts'` is not a value the schema allows, so the count
      // was always zero (OBS-01).
      collections: provider ? groups[provider].collections.filter(collection => collection.kind === 'address_book').length : 0,
      push: push.contacts,
    },
  };

  return {
    accountId: row.id,
    provider,
    mail: {
      transport,
      nativeTransport,
      native,
      ...mailAuth,
      ...synchronizationStateOf(syncStates.mail, mailAuth.authorized),
      // A migration is offered only for an account that classifies as the provider and is not already native.
      migrationAvailable: provider !== null && !native,
    },
    // Each group carries only its own collections, so `calendar.collections.length` is a calendar count and
    // `contacts.collections.length` an address-book count, as both the card and the diagnostics read them.
    calendar: provider
      ? { ...groups[provider], collections: groups[provider].collections.filter(collection => collection.kind === 'calendar') }
      : null,
    contacts: provider
      ? {
          ...groups[provider],
          enabled: serviceSettings.get('contacts')?.enabled === true,
          settingsRevision: serviceSettings.get('contacts')?.revision ?? 0,
          collections: groups[provider].collections.filter(collection => collection.kind === 'address_book'),
          ...(contactsAuth[provider] ?? { authorized: false, requiredScopes: [], grantedScopes: [], missingScopes: [] }),
          ...synchronizationStateOf(syncStates.contacts, contactsAuth[provider]?.authorized ?? false),
        }
      : null,
    push,
    diagnostics,
  };
}
