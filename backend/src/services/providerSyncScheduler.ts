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
let backoffMs = 0;
let nextAllowedAt = 0;
let lastRunRateLimited = false;

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
}

/**
 * Connections that have at least one linked collection. An account that was
 * connected but never pulled anything is deliberately absent.
 */
export async function listProviderSyncTargets(): Promise<ProviderSyncTarget[]> {
  const result = await query<{ user_id: string; connection_id: string; provider: string; features: string[] }>(
    `SELECT pc.user_id, pc.id AS connection_id, pc.provider,
            array_agg(DISTINCT ic.kind) AS features
       FROM provider_connections pc
       JOIN integration_collections ic
         ON ic.connection_id = pc.id
        AND ic.enabled = true
        AND (ic.local_calendar_id IS NOT NULL OR ic.local_address_book_id IS NOT NULL OR ic.local_folder_id IS NOT NULL)
        -- Gmail's mailbox is represented by a mail_label collection and Graph's by a mail_folder one; both link
        -- the local folder they pull into, which is the property this condition is about.
      WHERE pc.status = 'active' AND pc.provider IN ('google', 'microsoft')
      GROUP BY pc.user_id, pc.id, pc.provider
      ORDER BY pc.user_id, pc.id`,
  );
  return result.rows.map(row => ({
    userId: row.user_id,
    connectionId: row.connection_id,
    provider: row.provider,
    features: Array.isArray(row.features) ? row.features : [],
  }));
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
export function nextSyncBackoffMs(previousMs: number, rateLimited: boolean, random: () => number = Math.random): number {
  if (!rateLimited) return 0;
  const grown = previousMs > 0 ? previousMs * 2 : RATE_LIMIT_BACKOFF_BASE_MS;
  const capped = Math.min(grown, RATE_LIMIT_BACKOFF_MAX_MS);
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
  let rateLimited = false;

  for (const target of targets) {
    if (!ready[target.provider]) continue;
    for (const kind of target.features) {
      const sync = syncFor(target.provider, kind);
      if (!sync) continue;
      try {
        await sync(target, googleConfig, microsoftConfig);
        ran += 1;
      } catch (error) {
        failed += 1;
        // A throttled run is the one worth backing off from; anything else keeps its cadence.
        if ((error as { code?: string } | null)?.code === 'RATE_LIMITED') rateLimited = true;
        // A revoked grant or a provider outage must not stop the other connections.
        console.warn(`Scheduled ${target.provider} ${kind} sync failed for connection ${target.connectionId}:`, error instanceof Error ? error.message : error);
      }
    }
  }
  lastRunRateLimited = rateLimited;
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
  const sync = syncFor(input.provider, input.resourceType);
  if (!sync) return { ran: false, reason: 'NO_SYNC_FOR_RESOURCE' };
  await sync(
    { userId: input.userId, connectionId: input.connectionId, provider: input.provider, features: [input.resourceType] },
    googleConfig,
    microsoftConfig,
  );
  return { ran: true };
}

async function tick(): Promise<void> {
  // A slow pass must not overlap itself; the next tick simply waits.
  if (running) return;
  // And a throttled pass pushes the next one out, rather than retrying on the same cadence.
  if (Date.now() < nextAllowedAt) return;
  running = true;
  try {
    await runProviderSyncs();
    backoffMs = nextSyncBackoffMs(backoffMs, lastRunRateLimited);
    nextAllowedAt = Date.now() + backoffMs;
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
  backoffMs = 0;
  nextAllowedAt = 0;
  lastRunRateLimited = false;
}
