import { query } from './db.js';
import {
  googleConfigFromEnv,
  isGoogleConfigured,
  isMicrosoftConfigured,
  microsoftConfigFromEnv,
} from './providerAuthService.js';
import { syncGoogleContacts } from './providers/google/googleContactsSync.js';
import { syncGoogleCalendar } from './providers/google/googleCalendarSync.js';
import { syncGraphContacts } from './providers/microsoft/graphContactsSync.js';

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

const DEFAULT_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 24 * 60;

let timer: ReturnType<typeof setInterval> | null = null;
let firstPass: ReturnType<typeof setTimeout> | null = null;
let running = false;

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
        AND (ic.local_calendar_id IS NOT NULL OR ic.local_address_book_id IS NOT NULL)
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
export async function runProviderSyncs(): Promise<ProviderSyncRunSummary> {
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
    for (const kind of target.features) {
      const sync = syncFor(target.provider, kind);
      if (!sync) continue;
      try {
        await sync(target, googleConfig, microsoftConfig);
        ran += 1;
      } catch (error) {
        failed += 1;
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
    return null;
  }
  if (provider === 'microsoft') {
    // The Graph calendar adapter arrives with P07d; until then only contacts exist.
    if (kind === 'address_book') return (target, _google, microsoft) => syncGraphContacts({ userId: target.userId, connectionId: target.connectionId, config: microsoft });
    return null;
  }
  return null;
}

async function tick(): Promise<void> {
  // A slow pass must not overlap itself; the next tick simply waits.
  if (running) return;
  running = true;
  try {
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
}
