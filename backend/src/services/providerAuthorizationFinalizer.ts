import {
  googleConfigFromEnv,
  isGoogleConfigured,
  isMicrosoftConfigured,
  microsoftConfigFromEnv,
} from './providerAuthService.js';
import type { GoogleConfig, MicrosoftConfig } from './providerAuthService.js';
import { syncGmailMailLabelsForAccount, syncGmailMailMessagesForAccount } from './providers/google/gmailMailSync.js';
import { syncGoogleCalendar } from './providers/google/googleCalendarSync.js';
import { syncGoogleContacts } from './providers/google/googleContactsSync.js';
import { syncGraphMailFolders, syncGraphMailMessagesForAccount } from './providers/microsoft/graphMailSync.js';
import { syncGraphCalendar } from './providers/microsoft/graphCalendarSync.js';
import { syncGraphContacts } from './providers/microsoft/graphContactsSync.js';
import { withTransaction } from './db.js';
import { acquireSyncLease, ensureSyncState, failSyncRun } from './syncCoordinator.js';
import { accountProviderFeatureSettings } from './accountProviderFeatureSettings.js';
import { reduceProviderSyncResult, type ProviderSyncOutcome } from './providerSyncOutcome.js';

/**
 * Finish a provider authorization: run the first synchronization the purpose implies, right now.
 *
 * Authorization and synchronization are separate outcomes, and the interface needs both. A consent that stored
 * its grant but whose first run has not happened (or has failed) is **connected** — the live report was a
 * calendar showing `authorized`, six collections and "last synchronisation: never", and contacts authorized
 * with no address book at all, both waiting for a scheduler tick that may be fifteen minutes away or may not
 * come. This runs the run the user's click implied, and reports what happened.
 *
 * The grant is never rolled back because a sync failed: the authorization succeeded, and the failure belongs to
 * the feature's own sync state, which `synchronizationStateOf` and the account card already read.
 */

/**
 * The purposes the finalizer knows. `new_account` is the flow that creates a mailbox rather than attaching a
 * feature to one that exists, so it has nothing to synchronize and is not accepted here.
 */
export type ProviderAuthorizationPurpose = 'mail_migration' | 'calendar_enable' | 'contacts_enable' | 'account_enable';

/** Narrow an authorization purpose to the ones that run a first synchronization. */
export function isFinalizablePurpose(purpose: string): purpose is ProviderAuthorizationPurpose {
  return purpose === 'mail_migration' || purpose === 'calendar_enable' || purpose === 'contacts_enable'
    || purpose === 'account_enable';
}

export type { ProviderSyncOutcome } from './providerSyncOutcome.js';
type FinalizerSyncOutcome = ProviderSyncOutcome;

export interface ProviderAuthorizationResult {
  provider: 'google' | 'microsoft';
  purpose: ProviderAuthorizationPurpose;
  accountId: string | null;
  connectionId: string;
  /** The grant is stored: true even when the first synchronization failed. */
  authorized: boolean;
  /** A run completed. */
  synchronized: boolean;
  /** Authorized, but nothing has completed yet. */
  syncPending: boolean;
  /** The concrete failure of the first run, when it failed. */
  syncErrorCode: string | null;
  /** Truthful completion state; `synchronized` is true only for completed. */
  syncOutcome?: FinalizerSyncOutcome;
}

export interface FinalizeProviderAuthorizationInput {
  userId: string;
  provider: 'google' | 'microsoft';
  purpose: ProviderAuthorizationPurpose;
  /** The mailbox the authorization was started from, when the flow carried one. */
  targetAccountId: string | null;
  connectionId: string;
  /** Injectable for tests; the environment configuration is the default. */
  googleConfig?: GoogleConfig;
  microsoftConfig?: MicrosoftConfig;
}

/** The provider's own code for a failure, in the domain's vocabulary. */
function failureCodeOf(caught: unknown): string {
  const candidate = caught as { code?: unknown; status?: unknown } | null;
  if (typeof candidate?.code === 'string' && candidate.code) return candidate.code;
  const status = typeof candidate?.status === 'number' ? candidate.status : null;
  if (status === 401) return 'PROVIDER_AUTH_REQUIRED';
  // A bare 403 does not prove missing consent: Google also uses it for disabled
  // APIs, ACL/policy denial and unknown forbidden states.
  if (status === 403) return 'PROVIDER_FORBIDDEN';
  if (status === 429) return 'RATE_LIMITED';
  if (status !== null && status >= 500) return 'UPSTREAM_UNAVAILABLE';
  return 'SYNC_FAILED';
}

/** Adapter results intentionally survive the finalizer instead of becoming a bare success. */
type CalendarSyncRun = { errors?: Array<{ calendarId: string; code: string }>; incompleteCollections?: number; disabled?: boolean };
type FeatureSyncRun = { incomplete?: boolean; disabled?: boolean };


/** The first calendar run for one connection. */
async function runCalendarSync(input: FinalizeProviderAuthorizationInput): Promise<CalendarSyncRun> {
  if (input.provider === 'google') {
    const config = input.googleConfig ?? googleConfigFromEnv();
    if (!isGoogleConfigured(config)) throw Object.assign(new Error('Google API is not configured'), { code: 'ADMIN_CONFIGURATION_REQUIRED' });
    return await syncGoogleCalendar({ userId: input.userId, connectionId: input.connectionId, config });
  }
  const config = input.microsoftConfig ?? microsoftConfigFromEnv();
  if (!isMicrosoftConfigured(config)) throw Object.assign(new Error('Microsoft API is not configured'), { code: 'ADMIN_CONFIGURATION_REQUIRED' });
  return await syncGraphCalendar({ userId: input.userId, connectionId: input.connectionId, config });
}

/** The first contacts run for one connection. */
async function runContactsSync(input: FinalizeProviderAuthorizationInput): Promise<FeatureSyncRun> {
  if (input.provider === 'google') {
    const config = input.googleConfig ?? googleConfigFromEnv();
    if (!isGoogleConfigured(config)) throw Object.assign(new Error('Google API is not configured'), { code: 'ADMIN_CONFIGURATION_REQUIRED' });
    return await syncGoogleContacts({ userId: input.userId, connectionId: input.connectionId, config });
  }
  const config = input.microsoftConfig ?? microsoftConfigFromEnv();
  if (!isMicrosoftConfigured(config)) throw Object.assign(new Error('Microsoft API is not configured'), { code: 'ADMIN_CONFIGURATION_REQUIRED' });
  return await syncGraphContacts({ userId: input.userId, connectionId: input.connectionId, config });
}

/**
 * The first mail baseline for one connection.
 *
 * Discovery first — a message's folder is only resolvable once the label or folder paths exist — then the
 * messages of every mailbox the connection owns, which is the same order the scheduler uses.
 */
async function runMailBaseline(input: FinalizeProviderAuthorizationInput): Promise<FeatureSyncRun> {
  if (input.provider === 'google') {
    const config = input.googleConfig ?? googleConfigFromEnv();
    if (!isGoogleConfigured(config)) throw Object.assign(new Error('Google API is not configured'), { code: 'ADMIN_CONFIGURATION_REQUIRED' });
    const accountId = input.targetAccountId;
    if (!accountId) throw Object.assign(new Error('A mail migration needs the mailbox it belongs to'), { code: 'TARGET_ACCOUNT_REQUIRED' });
    await syncGmailMailLabelsForAccount({ userId: input.userId, connectionId: input.connectionId, accountId, config });
    return await syncGmailMailMessagesForAccount({ userId: input.userId, connectionId: input.connectionId, accountId, config });
  }
  const config = input.microsoftConfig ?? microsoftConfigFromEnv();
  if (!isMicrosoftConfigured(config)) throw Object.assign(new Error('Microsoft API is not configured'), { code: 'ADMIN_CONFIGURATION_REQUIRED' });
  const accountId = input.targetAccountId;
  if (!accountId) throw Object.assign(new Error('A mail migration needs the mailbox it belongs to'), { code: 'TARGET_ACCOUNT_REQUIRED' });
  await syncGraphMailFolders({ userId: input.userId, connectionId: input.connectionId, config });
    const result = await syncGraphMailMessagesForAccount({ userId: input.userId, connectionId: input.connectionId, accountId, config });
  return { incomplete: result.incompleteFolders > 0 || result.failedFolders > 0 };
}


/**
 * The `sync_states` feature and coverage each purpose's first run belongs to.
 *
 * A feature writes more than one kind of run (a calendar's discovery and its events, a mailbox's labels and its
 * messages), and the diagnostics report the pipeline's own coverage. A failure recorded under a different one is
 * invisible, so this writes the failure where the card reads. The feature names are the ones the sync writers
 * use, which is `calendars` for a calendar.
 */
type FinalizedFeature = 'mail' | 'calendars' | 'contacts';

const FEATURE_PIPELINE_COVERAGE: Record<FinalizedFeature, { google: string; microsoft: string }> = {
  mail: { google: 'history', microsoft: 'messages' },
  calendars: { google: 'events', microsoft: 'events' },
  contacts: { google: 'personal', microsoft: 'personal' },
};

/** Map an authorization purpose to the durable synchronization feature it updates. */
function featureForPurpose(purpose: ProviderAuthorizationPurpose): FinalizedFeature {
  if (purpose === 'calendar_enable') return 'calendars';
  if (purpose === 'contacts_enable') return 'contacts';
  return 'mail';
}

/**
 * Record a failed first synchronisation where the account's diagnostics will show it.
 *
 * The live report was "authorized, last synchronisation: never" with no error anywhere: the run threw before the
 * sync's own failure recorder was reached — or recorded it under a coverage the diagnostics do not read — so the
 * card had nothing to show and the cause had to be guessed at. This persists the code against the feature's
 * pipeline, which is what the diagnostics read.
 */
async function recordInitialSyncFailure(
  input: FinalizeProviderAuthorizationInput,
  code: string,
  feature: FinalizedFeature = featureForPurpose(input.purpose),
): Promise<void> {
  if (!input.targetAccountId) return;
  const coverage = FEATURE_PIPELINE_COVERAGE[feature][input.provider];
  await withTransaction(async client => {
    const syncStateId = await ensureSyncState(client, {
      userId: input.userId,
      connectionId: input.connectionId,
      // Mail state is stored per account; calendar and contact state is stored per connection with no account
      // id, which is how the sync writers create it and what the diagnostics read.
      accountId: feature === 'mail' ? input.targetAccountId : null,
      feature,
      collectionId: null,
      coverage,
    });
    const lease = await acquireSyncLease(client, { syncStateId, owner: 'provider-authorization-finalizer' });
    if (!lease) return;
    await failSyncRun(client, { syncStateId, generation: lease.generation, errorCode: code });
  });
}

/**
 * Re-read durable intent after the callback. A user who disables a service while
 * the provider consent page is open must not have its first discovery resurrect it.
 * Standalone feature connections have no mailbox target and retain their explicit
 * provider-purpose behavior.
 */
async function featureStillEnabled(input: FinalizeProviderAuthorizationInput, feature: 'calendars' | 'contacts'): Promise<boolean> {
  if (!input.targetAccountId) return true;
  const setting = (await accountProviderFeatureSettings(input.targetAccountId)).find(entry => entry.feature === feature);
  return setting?.enabled === true;
}

export async function finalizeProviderAuthorization(
  input: FinalizeProviderAuthorizationInput,
): Promise<ProviderAuthorizationResult> {
  const base = {
    provider: input.provider,
    purpose: input.purpose,
    accountId: input.targetAccountId,
    connectionId: input.connectionId,
    authorized: true,
  };

  try {
    if (input.purpose === 'calendar_enable') {
      if (!await featureStillEnabled(input, 'calendars')) {
        return { ...base, synchronized: false, syncPending: false, syncErrorCode: 'FEATURE_DISABLED', syncOutcome: 'skipped_disabled' };
      }
      const calendar = await runCalendarSync(input);
      const reduced = reduceProviderSyncResult(calendar);
      if (reduced.outcome !== 'completed') {
        if (reduced.outcome !== 'skipped_disabled') await recordInitialSyncFailure(input, reduced.errorCode ?? 'SYNC_FAILED', 'calendars').catch(() => {});
        return { ...base, synchronized: reduced.synchronized, syncPending: reduced.syncPending, syncErrorCode: reduced.errorCode, syncOutcome: reduced.outcome };
      }
    }
    else if (input.purpose === 'contacts_enable') {
      if (!await featureStillEnabled(input, 'contacts')) {
        return { ...base, synchronized: false, syncPending: false, syncErrorCode: 'FEATURE_DISABLED', syncOutcome: 'skipped_disabled' };
      }
      const reduced = reduceProviderSyncResult(await runContactsSync(input));
      if (reduced.outcome !== 'completed') {
        if (reduced.outcome !== 'skipped_disabled') await recordInitialSyncFailure(input, reduced.errorCode ?? 'SYNC_FAILED', 'contacts').catch(() => {});
        return { ...base, synchronized: reduced.synchronized, syncPending: reduced.syncPending, syncErrorCode: reduced.errorCode, syncOutcome: reduced.outcome };
      }
    }
    else if (input.purpose === 'account_enable') {
      // One consent covers the whole mailbox, so every feature it authorized is primed now. A failure in one of
      // them must not stop the others: each feature records its own state, and the first failure is reported.
      const failures: Array<{ feature: FinalizedFeature; code: string; outcome: FinalizerSyncOutcome }> = [];
      if (await featureStillEnabled(input, 'calendars')) {
        try {
          const reduced = reduceProviderSyncResult(await runCalendarSync(input));
          if (reduced.outcome !== 'completed') failures.push({ feature: 'calendars', outcome: reduced.outcome, code: reduced.errorCode ?? 'SYNC_FAILED' });
        } catch (caught) { failures.push({ feature: 'calendars', outcome: 'failed', code: failureCodeOf(caught) }); }
      }
      if (await featureStillEnabled(input, 'contacts')) {
        try {
          const reduced = reduceProviderSyncResult(await runContactsSync(input));
          if (reduced.outcome !== 'completed') failures.push({ feature: 'contacts', outcome: reduced.outcome, code: reduced.errorCode ?? 'SYNC_FAILED' });
        } catch (caught) { failures.push({ feature: 'contacts', outcome: 'failed', code: failureCodeOf(caught) }); }
      }
      // The mail baseline only applies to a mailbox the flow named; a bare consent reuses what syncs exist.
      if (input.targetAccountId) {
        try {
          const reduced = reduceProviderSyncResult(await runMailBaseline(input));
          if (reduced.outcome !== 'completed') failures.push({ feature: 'mail', outcome: reduced.outcome, code: reduced.errorCode ?? 'SYNC_FAILED' });
        } catch (caught) { failures.push({ feature: 'mail', outcome: 'failed', code: failureCodeOf(caught) }); }
      }
      if (failures.length) {
        console.warn(`Initial sync after a single consent partly failed for ${input.provider}:`, failures.map(failure => failure.code).join(','));
        // Persist each failure against its own feature, so the card can name the part that failed rather than
        // only the first one (OBS-02).
        for (const failure of failures) {
          await recordInitialSyncFailure(input, failure.code, failure.feature).catch(() => { /* reported below */ });
        }
        return {
          ...base, synchronized: false,
          syncPending: failures.some(failure => failure.outcome === 'incomplete'),
          syncErrorCode: failures[0]!.code,
          syncOutcome: failures.some(failure => failure.outcome === 'partial') ? 'partial'
            : failures.some(failure => failure.outcome === 'incomplete') ? 'incomplete'
              : failures.some(failure => failure.outcome === 'skipped_disabled') ? 'skipped_disabled' : 'failed',
        };
      }
    }
    else await runMailBaseline(input);
    return { ...base, synchronized: true, syncPending: false, syncErrorCode: null, syncOutcome: 'completed' };
  } catch (caught) {
    // The grant stays. The failure is reported with the provider's own code so the card can say
    // "connected, synchronisation failed" instead of asking for a reconnection that changes nothing.
    const code = failureCodeOf(caught);
    console.warn(`Initial ${input.purpose} sync after authorization failed for ${input.provider}:`, code);
    await recordInitialSyncFailure(input, code).catch(() => { /* the result is still reported below */ });
    return {
      ...base, synchronized: false, syncPending: false, syncErrorCode: code,
      syncOutcome: code === 'PROVIDER_AUTH_REQUIRED' || code === 'INSUFFICIENT_SCOPES' ? 'auth_required' : 'failed',
    };
  }
}

/** The query-string facts the opener needs, without a token or any credential. */
export function authorizationResultQuery(result: ProviderAuthorizationResult): string {
  const params = new URLSearchParams({ provider: result.provider, purpose: result.purpose });
  if (result.accountId) params.set('accountId', result.accountId);
  params.set('authorized', result.authorized ? '1' : '0');
  params.set('synchronized', result.synchronized ? '1' : '0');
  if (result.syncErrorCode) params.set('syncErrorCode', result.syncErrorCode);
  if (result.syncOutcome) params.set('syncOutcome', result.syncOutcome);
  return params.toString();
}
