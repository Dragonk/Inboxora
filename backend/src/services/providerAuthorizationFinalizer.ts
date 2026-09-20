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
export type ProviderAuthorizationPurpose = 'mail_migration' | 'calendar_enable' | 'contacts_enable';

/** Narrow an authorization purpose to the ones that run a first synchronization. */
export function isFinalizablePurpose(purpose: string): purpose is ProviderAuthorizationPurpose {
  return purpose === 'mail_migration' || purpose === 'calendar_enable' || purpose === 'contacts_enable';
}

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
  if (status === 403) return 'INSUFFICIENT_SCOPES';
  if (status === 429) return 'RATE_LIMITED';
  if (status !== null && status >= 500) return 'UPSTREAM_UNAVAILABLE';
  return 'SYNC_FAILED';
}

/** The first calendar run for one connection. */
async function runCalendarSync(input: FinalizeProviderAuthorizationInput): Promise<void> {
  if (input.provider === 'google') {
    const config = input.googleConfig ?? googleConfigFromEnv();
    if (!isGoogleConfigured(config)) throw Object.assign(new Error('Google API is not configured'), { code: 'ADMIN_CONFIGURATION_REQUIRED' });
    await syncGoogleCalendar({ userId: input.userId, connectionId: input.connectionId, config });
    return;
  }
  const config = input.microsoftConfig ?? microsoftConfigFromEnv();
  if (!isMicrosoftConfigured(config)) throw Object.assign(new Error('Microsoft API is not configured'), { code: 'ADMIN_CONFIGURATION_REQUIRED' });
  await syncGraphCalendar({ userId: input.userId, connectionId: input.connectionId, config });
}

/** The first contacts run for one connection. */
async function runContactsSync(input: FinalizeProviderAuthorizationInput): Promise<void> {
  if (input.provider === 'google') {
    const config = input.googleConfig ?? googleConfigFromEnv();
    if (!isGoogleConfigured(config)) throw Object.assign(new Error('Google API is not configured'), { code: 'ADMIN_CONFIGURATION_REQUIRED' });
    await syncGoogleContacts({ userId: input.userId, connectionId: input.connectionId, config });
    return;
  }
  const config = input.microsoftConfig ?? microsoftConfigFromEnv();
  if (!isMicrosoftConfigured(config)) throw Object.assign(new Error('Microsoft API is not configured'), { code: 'ADMIN_CONFIGURATION_REQUIRED' });
  await syncGraphContacts({ userId: input.userId, connectionId: input.connectionId, config });
}

/**
 * The first mail baseline for one connection.
 *
 * Discovery first — a message's folder is only resolvable once the label or folder paths exist — then the
 * messages of every mailbox the connection owns, which is the same order the scheduler uses.
 */
async function runMailBaseline(input: FinalizeProviderAuthorizationInput): Promise<void> {
  if (input.provider === 'google') {
    const config = input.googleConfig ?? googleConfigFromEnv();
    if (!isGoogleConfigured(config)) throw Object.assign(new Error('Google API is not configured'), { code: 'ADMIN_CONFIGURATION_REQUIRED' });
    const accountId = input.targetAccountId;
    if (!accountId) throw Object.assign(new Error('A mail migration needs the mailbox it belongs to'), { code: 'TARGET_ACCOUNT_REQUIRED' });
    await syncGmailMailLabelsForAccount({ userId: input.userId, connectionId: input.connectionId, accountId, config });
    await syncGmailMailMessagesForAccount({ userId: input.userId, connectionId: input.connectionId, accountId, config });
    return;
  }
  const config = input.microsoftConfig ?? microsoftConfigFromEnv();
  if (!isMicrosoftConfigured(config)) throw Object.assign(new Error('Microsoft API is not configured'), { code: 'ADMIN_CONFIGURATION_REQUIRED' });
  const accountId = input.targetAccountId;
  if (!accountId) throw Object.assign(new Error('A mail migration needs the mailbox it belongs to'), { code: 'TARGET_ACCOUNT_REQUIRED' });
  await syncGraphMailFolders({ userId: input.userId, connectionId: input.connectionId, config });
  await syncGraphMailMessagesForAccount({ userId: input.userId, connectionId: input.connectionId, accountId, config });
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
    if (input.purpose === 'calendar_enable') await runCalendarSync(input);
    else if (input.purpose === 'contacts_enable') await runContactsSync(input);
    else await runMailBaseline(input);
    return { ...base, synchronized: true, syncPending: false, syncErrorCode: null };
  } catch (caught) {
    // The grant stays. The failure is reported with the provider's own code so the card can say
    // "connected, synchronisation failed" instead of asking for a reconnection that changes nothing.
    const code = failureCodeOf(caught);
    console.warn(`Initial ${input.purpose} sync after authorization failed for ${input.provider}:`, code);
    return { ...base, synchronized: false, syncPending: false, syncErrorCode: code };
  }
}

/** The query-string facts the opener needs, without a token or any credential. */
export function authorizationResultQuery(result: ProviderAuthorizationResult): string {
  const params = new URLSearchParams({ provider: result.provider, purpose: result.purpose });
  if (result.accountId) params.set('accountId', result.accountId);
  params.set('authorized', result.authorized ? '1' : '0');
  params.set('synchronized', result.synchronized ? '1' : '0');
  if (result.syncErrorCode) params.set('syncErrorCode', result.syncErrorCode);
  return params.toString();
}
