import { query, withTransaction } from './db.js';
import { providerIntegrationsEnabled } from './providerSwitches.js';
import {
  googleConfigFromEnv,
  isGoogleConfigured,
  isMicrosoftConfigured,
  microsoftConfigFromEnv,
} from './providerAuthService.js';
import { syncGoogleContacts } from './providers/google/googleContactsSync.js';
import { syncGoogleCalendar } from './providers/google/googleCalendarSync.js';
import { syncGraphContacts } from './providers/microsoft/graphContactsSync.js';
import { syncGraphCalendar } from './providers/microsoft/graphCalendarSync.js';
import { syncGraphMailFolders, syncGraphMailMessagesForAccount } from './providers/microsoft/graphMailSync.js';
import { listGmailMailAccounts, syncGmailMailLabelsForAccount, syncGmailMailMessagesForAccount } from './providers/google/gmailMailSync.js';
import { collectionKindForAccountProviderService, providerConnectionFeatureEnabled } from './accountProviderFeatureSettings.js';

/**
 * Periodic refresh of the provider collections a user has already pulled (P09).
 *
 * Only collections that already exist are refreshed: the schedule never starts
 * importing data nobody asked for, and connecting an account stays a deliberate
 * act while keeping it fresh is automatic.
 *
 * Every sync is lease-protected and cursor-guarded, so an overlapping tick, a
 * restarted process and a manual "Sync now" cannot double-run or advance a cursor
 * out of order. A failure is logged and retried on the next tick; it never aborts
 * the other connections.
 */

/**
 * How often the provider mail of an already-pulled collection is polled.
 *
 * Fifteen minutes was far behind the IMAP fetch it replaced (which ran every few seconds), and with no push
 * subscription active the polling interval **is** the delivery latency: the live report was a new mail taking
 * "kilkanaście minut" to appear unless the user refreshed by hand. Two minutes keeps the request volume modest
 * while making the fallback behave like a mailbox. `PROVIDER_SYNC_INTERVAL_MINUTES` overrides it, and `0`
 * disables the schedule.
 */
const DEFAULT_INTERVAL_MINUTES = 2;
const MAX_INTERVAL_MINUTES = 24 * 60;

let timer: ReturnType<typeof setInterval> | null = null;
let firstPass: ReturnType<typeof setTimeout> | null = null;
let running = false;
/**
 * Delay before the next attempt of one collection, after the *provider* throttled it.
 *
 * Keyed by connection + collection kind, not held as one installation-wide timestamp: a single rate-limited
 * mailbox used to push out every other user's and provider's refresh (SYNC-08). This application's own lease
 * conflict never sets it, because another worker refreshing the collection is not the provider throttling us.
 */
const syncBackoffs = new Map<string, { ms: number; until: number }>();

function scopeKey(target: ProviderSyncTarget, kind: string): string {
  return `${target.connectionId}:${kind}`;
}

/**
 * How long after start the first pass runs. A restart must not leave pulled data
 * stale for a whole interval, but it also must not compete with the rest of
 * start-up, so the first pass is delayed rather than immediate.
 */
export const FIRST_PASS_DELAY_MS = 30_000;

/**
 * The refresh cadence. `0` disables the schedule (useful for tests and for an
 * operator who triggers syncs themselves); an unset or unusable value keeps the
 * default rather than silently disabling it.
 */
export function providerSyncIntervalMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PROVIDER_SYNC_INTERVAL_MINUTES;
  if (raw === undefined || raw === '') return DEFAULT_INTERVAL_MINUTES;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_INTERVAL_MINUTES;
  if (value === 0) return 0;
  return Math.min(MAX_INTERVAL_MINUTES, Math.floor(value));
}

export interface ProviderSyncTarget {
  userId: string;
  connectionId: string;
  provider: string;
  /** The collection kinds this connection has already pulled. */
  features: string[];
  /** Account settings may request first discovery before a collection exists. */
  desiredFeatures?: string[];
  /**
   * True when the connection holds **no** collection yet, so its first discovery still has to run (SYNC-01).
   *
   * Discovery used to be reachable only through a collection that already existed, so a connection whose initial
   * discovery failed or was interrupted was never retried: the schedule skipped it forever and the account stayed
   * empty until the user acted. The absence of collections is itself the durable retry signal — it survives a
   * restart without any extra bookkeeping — and each attempt's outcome is recorded where every other sync's is,
   * in `sync_states` for the feature it tried to discover.
   */
  discovery: boolean;
}

/**
 * Connections that have at least one linked collection, plus those that have none yet and must be discovered.
 *
 * A connection with collections is scheduled per collection. A connection with none is scheduled for discovery:
 * it is an active, authorized connection, so the user has asked for it and the only reason it holds nothing is
 * that discovery has not succeeded yet.
 */
export async function listProviderSyncTargets(): Promise<ProviderSyncTarget[]> {
  // One query, so the two cases cannot disagree about what a connection holds. A connection with usable
  // collections is scheduled per collection; a connection with **no collection row at all** is scheduled for the
  // discovery that creates the first one (SYNC-01). A connection whose only collections are unusable — disabled,
  // or with no local link — is still absent, which is the rule the schedule has always had.
  const result = await query<{ user_id: string; connection_id: string; provider: string; features: string[] | null; desired_features: string[] | null; discovery: boolean }>(
    `SELECT pc.user_id, pc.id AS connection_id, pc.provider,
            array_agg(DISTINCT ic.kind) FILTER (
              WHERE ic.id IS NOT NULL
                AND ic.enabled = true
                AND (ic.local_calendar_id IS NOT NULL OR ic.local_address_book_id IS NOT NULL OR ic.local_folder_id IS NOT NULL)
            ) AS features,
            (COUNT(ic.id) = 0) AS discovery
       FROM provider_connections pc
       LEFT JOIN integration_collections ic ON ic.connection_id = pc.id
        -- Gmail's mailbox is represented by a mail_label collection and Graph's by a mail_folder one; both link
        -- the local folder they pull into, which is the property the feature array is about.
      WHERE pc.status = 'active' AND pc.provider IN ('google', 'microsoft')
      GROUP BY pc.user_id, pc.id, pc.provider
      ORDER BY pc.user_id, pc.id`,
  );
  // Desired optional services are account intent, not an accidental consequence of an
  // existing collection. A calendar/contact setting must therefore survive a failed
  // first discovery and be visible to the scheduler after a restart.
  const desired = await query<{ connection_id: string; feature: 'calendars' | 'contacts'; enabled: boolean }>(
    `SELECT pc.id AS connection_id, s.feature, s.enabled
       FROM account_provider_feature_settings s
       JOIN email_accounts a ON a.id = s.account_id
       JOIN provider_connections pc ON pc.id = a.provider_connection_id
      WHERE pc.status = 'active' AND pc.user_id = a.user_id
        AND pc.provider IN ('google', 'microsoft')`,
  );
  const featureStateByConnection = new Map<string, Map<string, boolean>>();
  for (const row of desired.rows) {
    const state = featureStateByConnection.get(row.connection_id) ?? new Map<string, boolean>();
    const kind = collectionKindForAccountProviderService(row.feature);
    // A connection can only run a shared optional feature if at least one of its
    // owning accounts still opts in; no setting means a standalone legacy source.
    state.set(kind, state.get(kind) === true || row.enabled === true);
    featureStateByConnection.set(row.connection_id, state);
  }

  const targets: ProviderSyncTarget[] = [];
  for (const row of result.rows) {
    const discovery = row.discovery === true;
    // A driver that hands back no array at all is the pre-existing defensive case: the row is kept with no
    // features rather than dropped.
    const rawFeatures = row.features === null || row.features === undefined
      ? null
      : (Array.isArray(row.features) ? row.features : []);
    const featureState = featureStateByConnection.get(row.connection_id);
    const features = rawFeatures === null ? null : rawFeatures.filter(kind =>
      (kind !== 'calendar' && kind !== 'address_book') || featureState?.get(kind) !== false,
    );
    const desiredFeatures = [...(featureState?.entries() ?? [])]
      .filter(([, enabled]) => enabled)
      .map(([kind]) => kind);
    if (!discovery && features !== null && features.length === 0 && desiredFeatures.length === 0) continue;
    targets.push({
      userId: row.user_id,
      connectionId: row.connection_id,
      provider: row.provider,
      features: features ?? [],
      ...(desiredFeatures.length ? { desiredFeatures } : {}),
      discovery,
    });
  }
  return targets;
}

/**
 * The collection kind whose sync *is* discovery for a provider.
 *
 * Google's mail discovery writes `mail_label` collections and Graph's writes `mail_folder` ones, and each of
 * those adapters discovers before it pulls — which is why a discovery target reuses the mail adapter rather than
 * a second discovery path that could drift from it.
 */
function discoveryKindFor(provider: string): string | null {
  if (provider === 'google') return 'mail_label';
  if (provider === 'microsoft') return 'mail_folder';
  return null;
}

export interface ProviderSyncRunSummary {
  connections: number;
  ran: number;
  failed: number;
}

/** Refresh every already-pulled collection of every active provider connection. */
/** Base delay after a throttled run, and the ceiling it doubles towards. */
const RATE_LIMIT_BACKOFF_BASE_MS = 60_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 30 * 60_000;

/**
 * How long to wait before the next pass, given the previous delay and whether the last one was throttled.
 *
 * A fixed interval retries a throttled collection on the same cadence as a healthy one, which is what the plan
 * asks not to do: `Retry-After` is parsed and stored by the classifiers, but the schedule ignored it. Doubling
 * with jitter avoids a fleet of installations retrying in lockstep, and a healthy pass resets the delay to zero.
 */
export function nextSyncBackoffMs(
  previousMs: number,
  rateLimited: boolean,
  random: () => number = Math.random,
  retryAfterSeconds?: number,
): number {
  if (!rateLimited) return 0;
  // The provider's own Retry-After wins when it named one — it is the one value that says when calling again
  // is acceptable — but it is still bounded, and jittered so a fleet does not retry in lockstep.
  const requested = retryAfterSeconds && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0;
  const grown = previousMs > 0 ? previousMs * 2 : RATE_LIMIT_BACKOFF_BASE_MS;
  const capped = Math.min(Math.max(grown, requested), RATE_LIMIT_BACKOFF_MAX_MS);
  // Up to a quarter of the delay as jitter, so the retries spread out.
  return capped + Math.floor(random() * (capped / 4));
}

export async function runProviderSyncs(): Promise<ProviderSyncRunSummary> {
  // The installation switch reaches the schedule too: with the layer off, a run must not call a provider
  // for collections that were pulled earlier. Reported as a run of nothing rather than an error, since the
  // schedule is not a user action.
  if (!providerIntegrationsEnabled()) return { ran: 0, failed: 0, connections: 0 };
  const targets = await listProviderSyncTargets();
  const googleConfig = googleConfigFromEnv();
  const microsoftConfig = microsoftConfigFromEnv();
  // Readiness is per provider: an unconfigured Google must never stop Microsoft.
  const ready: Record<string, boolean> = {
    google: isGoogleConfigured(googleConfig),
    microsoft: isMicrosoftConfigured(microsoftConfig),
  };
  let ran = 0;
  let failed = 0;

  for (const target of targets) {
    if (!ready[target.provider]) continue;
    // A connection holding nothing is scheduled for the one sync that discovers: a collection cannot be required
    // for the run that creates the first collection (SYNC-01).
    const discoveryKind = target.discovery ? discoveryKindFor(target.provider) : null;
    if (target.discovery && !discoveryKind) continue;
    // Mail remains the initial discovery for a newly created mailbox. Optional
    // account services add their own desired targets even when mail/contact rows
    // already exist, fixing the permanent zero-calendar discovery gap.
    const kinds = [...new Set([
      ...(target.discovery ? [discoveryKind as string] : target.features),
      ...(target.desiredFeatures ?? []),
    ])];
    for (const kind of kinds) {
      const sync = syncFor(target.provider, kind);
      if (!sync) continue;
      const key = scopeKey(target, kind);
      const backoff = syncBackoffs.get(key);
      // Only this collection waits out its own backoff; every other connection and provider carries on.
      if (backoff && Date.now() < backoff.until) continue;
      try {
        await sync(target, googleConfig, microsoftConfig);
        syncBackoffs.delete(key);
        ran += 1;
        if (target.discovery) {
          console.info(`Discovered the first collections of ${target.provider} connection ${target.connectionId}`);
        }
      } catch (error) {
        failed += 1;
        const failure = error as { code?: string; retryAfterSeconds?: number } | null;
        // A throttled run backs off **this collection**, honouring the provider's Retry-After when it named
        // one. Anything else — including our own `SYNC_ALREADY_RUNNING`, where another worker is already
        // refreshing this collection — keeps its cadence, and must never suppress the other connections.
        if (failure?.code === 'RATE_LIMITED') {
          const previous = syncBackoffs.get(key)?.ms ?? 0;
          const ms = nextSyncBackoffMs(previous, true, Math.random, failure.retryAfterSeconds);
          syncBackoffs.set(key, { ms, until: Date.now() + ms });
        }
        // A revoked grant or a provider outage must not stop the other connections.
        console.warn(`Scheduled ${target.provider} ${kind} sync failed for connection ${target.connectionId}:`, error instanceof Error ? error.message : error);
      }
    }
  }
  return { connections: targets.length, ran, failed };
}

/** The adapter for a provider/collection pair, or null when there is none yet. */
function syncFor(provider: string, kind: string): ((target: ProviderSyncTarget, google: ReturnType<typeof googleConfigFromEnv>, microsoft: ReturnType<typeof microsoftConfigFromEnv>) => Promise<unknown>) | null {
  if (provider === 'google') {
    if (kind === 'address_book') return (target, google) => syncGoogleContacts({ userId: target.userId, connectionId: target.connectionId, config: google });
    if (kind === 'calendar') return (target, google) => syncGoogleCalendar({ userId: target.userId, connectionId: target.connectionId, config: google });
    // Google's mail collection is `mail_label` — the value the Gmail label discovery writes and migration
    // 0101 declares — while Graph's is `mail_folder`. Matching only the Graph spelling meant a native Gmail
    // connection had no scheduled message sync at all: its only collection kind was unknown to this
    // dispatcher, so new mail arrived only on a manual sync or a push notification, which is exactly the
    // "mail does not appear by itself" the live round reported.
    if (kind === 'mail_folder' || kind === 'mail_label') {
      // Labels first (a message's folder is only resolvable once the label paths exist), then the messages of
      // every account this connection owns. This is also Gmail's polling fallback: with push enabled it
      // simply runs less often, and with push unavailable it is the only thing keeping the mailbox fresh.
      return async (target, google) => {
        const accounts = await withTransaction(client => listGmailMailAccounts(client, { userId: target.userId, connectionId: target.connectionId }));
        if (accounts.length === 0) {
          // A connection with no mailbox under it has nothing to synchronise. Falling back to the connection id
          // as the account id — which is a different kind of identifier — would call the Gmail sync with a value
          // that cannot address a mailbox, and the failure would surface later and less clearly than this.
          console.warn(`Skipping Gmail mail sync for connection ${target.connectionId}: NO_ACCOUNT_FOR_CONNECTION`);
          return { skipped: 'NO_ACCOUNT_FOR_CONNECTION', connectionId: target.connectionId };
        }
        // Labels first, then every account the connection owns; the label sync needs a real mailbox to write
        // its label paths against, and there is at least one by the check above.
        const labels = await syncGmailMailLabelsForAccount({ userId: target.userId, connectionId: target.connectionId, accountId: accounts[0], config: google });
        const messages = [];
        for (const accountId of accounts) {
          messages.push(await syncGmailMailMessagesForAccount({ userId: target.userId, connectionId: target.connectionId, accountId, config: google }));
        }
        return { labels, messages };
      };
    }
    return null;
  }
  if (provider === 'microsoft') {
    // A mail folder sync is a full snapshot, so an overlapping tick is refused by the
    // lease rather than queued.
    if (kind === 'address_book') return (target, _google, microsoft) => syncGraphContacts({ userId: target.userId, connectionId: target.connectionId, config: microsoft });
    if (kind === 'calendar') return (target, _google, microsoft) => syncGraphCalendar({ userId: target.userId, connectionId: target.connectionId, config: microsoft });
    if (kind === 'mail_folder') {
      // Discovery first, then the messages: the per-folder delta cursors belong to
      // the folders discovery maintains, so a new folder is only ever synced after
      // it has a collection to hold its cursor.
      return async (target, _google, microsoft) => {
        const folders = await syncGraphMailFolders({ userId: target.userId, connectionId: target.connectionId, config: microsoft });
        const messages = [];
        for (const account of folders) {
          messages.push(await syncGraphMailMessagesForAccount({
            userId: target.userId, connectionId: target.connectionId, accountId: account.accountId, config: microsoft,
          }));
        }
        return { folders, messages };
      };
    }
    return null;
  }
  return null;
}

/**
 * Run the sync one resource type needs, for one connection.
 *
 * This is the same adapter the schedule calls, reached the same way: a push hint changes *when* a sync runs,
 * never what it does, so a notification cannot introduce a second synchronisation path.
 */
export async function runProviderSyncForHint(input: {
  userId: string;
  connectionId: string;
  provider: string;
  resourceType: string;
}): Promise<{ ran: boolean; reason?: string }> {
  if (!providerIntegrationsEnabled()) return { ran: false, reason: 'PROVIDER_INTEGRATIONS_DISABLED' };
  const googleConfig = googleConfigFromEnv();
  const microsoftConfig = microsoftConfigFromEnv();
  const ready = input.provider === 'google' ? isGoogleConfigured(googleConfig) : isMicrosoftConfigured(microsoftConfig);
  if (!ready) return { ran: false, reason: 'PROVIDER_NOT_CONFIGURED' };
  const optionalFeature = input.resourceType === 'calendar' ? 'calendars'
    : input.resourceType === 'contacts' ? 'contacts' : null;
  if (optionalFeature && !await providerConnectionFeatureEnabled({
    userId: input.userId, connectionId: input.connectionId, feature: optionalFeature,
  })) return { ran: false, reason: 'FEATURE_DISABLED' };
  const sync = syncFor(input.provider, input.resourceType);
  if (!sync) return { ran: false, reason: 'NO_SYNC_FOR_RESOURCE' };
  await sync(
    { userId: input.userId, connectionId: input.connectionId, provider: input.provider, features: [input.resourceType], discovery: false },
    googleConfig,
    microsoftConfig,
  );
  return { ran: true };
}

async function tick(): Promise<void> {
  // A slow pass must not overlap itself; the next tick simply waits.
  if (running) return;
  running = true;
  try {
    // No installation-wide gate: each collection's own backoff is applied inside the pass, so a throttled
    // connection no longer postpones the healthy ones (SYNC-08).
    await runProviderSyncs();
  } catch (error) {
    console.warn('Scheduled provider sync pass failed:', error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
}

/** Arm (or re-arm) the schedule. Calling it again replaces the previous timers. */
export function startProviderSyncScheduler(env: NodeJS.ProcessEnv = process.env): void {
  stopProviderSyncScheduler();
  const minutes = providerSyncIntervalMinutes(env);
  if (minutes === 0) return;
  firstPass = setTimeout(() => { void tick(); }, FIRST_PASS_DELAY_MS);
  // Do not hold the process open just for a background refresh.
  if (typeof firstPass.unref === 'function') firstPass.unref();
  timer = setInterval(() => { void tick(); }, minutes * 60_000);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopProviderSyncScheduler(): void {
  if (firstPass) clearTimeout(firstPass);
  firstPass = null;
  if (timer) clearInterval(timer);
  timer = null;
  // Stopping clears the scheduling state with the timers: a backoff left behind would silently suppress the
  // next start's first pass, which is how this leaked between tests when it was introduced.
  syncBackoffs.clear();
}
