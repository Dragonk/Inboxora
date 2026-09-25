import { useCallback, useEffect, useState } from 'react';
import { api } from '../utils/api.ts';
import { toAppError } from '../utils/errors.ts';

/**
 * "Instant synchronization" for one provider connection.
 *
 * Push is an accelerator, never a requirement: the card says whether it is active, whether the installation
 * is falling back to polling (no public HTTPS URL, or push switched off), and whether the last renewal
 * failed — and it never implies the account is broken without it. What is registered is exactly what the
 * connection pulled, and the strings that describe the state are the interface's; the server sends facts.
 */

export interface ProviderPushSubscriptionStatus {
  id: string;
  connectionId: string;
  provider: string;
  resourceType: string;
  status: string;
  expiresAt: string | null;
  lastNotificationAt: string | null;
  lastRenewedAt: string | null;
  lastErrorCode: string | null;
}

export interface ProviderPushStatus {
  enabled: boolean;
  webhookBaseUrl: string | null;
  reason: string | null;
  microsoft?: { available: boolean; reason: string | null; resources: string[] };
  google?: {
    gmailAvailable: boolean;
    gmailReason: string | null;
    calendarAvailable: boolean;
    calendarReason: string | null;
    contacts: { push: boolean; strategy: string };
  };
  subscriptions: ProviderPushSubscriptionStatus[];
}

interface Props {
  provider: 'microsoft' | 'google';
  connectionId: string;
  /** Shared status, fetched once by the integrations panel and passed down. */
  status: ProviderPushStatus | null;
  reloadStatus: () => void;
  t: (key: string, vars?: Record<string, unknown>) => string;
}

/** Which state the card shows, in the order that matters to the reader. */
export function pushStateFor(input: {
  provider: 'microsoft' | 'google';
  status: ProviderPushStatus | null;
  subscriptions: ProviderPushSubscriptionStatus[];
}): 'unconfigured' | 'disabled' | 'needs_url' | 'renewal_error' | 'active' | 'available' {
  const status = input.status;
  if (!status) return 'available';
  if (!status.enabled) return 'disabled';
  if (!status.webhookBaseUrl) return 'needs_url';
  if (input.subscriptions.some(row => row.lastErrorCode)) return 'renewal_error';
  if (input.subscriptions.some(row => row.status === 'active')) return 'active';
  return 'available';
}

export default function ProviderPushControls({ provider, connectionId, status, reloadStatus, t }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState<ProviderPushStatus | null>(status);

  useEffect(() => { setLocal(status); }, [status]);

  const subscriptions = (local?.subscriptions ?? []).filter(row => row.connectionId === connectionId);
  const state = pushStateFor({ provider, status: local, subscriptions });
  const activeCount = subscriptions.filter(row => row.status === 'active').length;
  const expiry = subscriptions
    .map(row => row.expiresAt)
    .filter((value): value is string => Boolean(value))
    .sort()[0] ?? null;
  const lastNotification = subscriptions
    .map(row => row.lastNotificationAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .pop() ?? null;
  const renewalError = subscriptions.find(row => row.lastErrorCode)?.lastErrorCode ?? null;
  const reason = provider === 'microsoft' ? local?.microsoft?.reason : local?.google?.gmailReason;

  const refresh = useCallback(async () => {
    try {
      const next = await api.getProviderPushStatus() as ProviderPushStatus;
      setLocal(next);
      reloadStatus();
    } catch { /* the panel's own load reports a failure; this refresh is best effort */ }
  }, [reloadStatus]);

  const toggle = useCallback(async (enable: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (enable) await api.enableConnectionPush(connectionId);
      else await api.disableConnectionPush(connectionId);
      await refresh();
    } catch (caught) {
      setError(toAppError(caught).message);
    } finally {
      setBusy(false);
    }
  }, [connectionId, refresh]);

  const stateLabel: Record<ReturnType<typeof pushStateFor>, string> = {
    active: t('admin.integrations.push.stateActive'),
    available: t('admin.integrations.push.stateAvailable'),
    renewal_error: t('admin.integrations.push.stateRenewalError'),
    needs_url: t('admin.integrations.push.stateNeedsUrl'),
    disabled: t('admin.integrations.push.statePollingFallback'),
    unconfigured: t('admin.integrations.push.statePollingFallback'),
  };

  return (
    <div data-testid={`provider-push-${provider}`} style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6 }}>
      <div style={{ color: 'var(--text-secondary)' }}>{t('admin.integrations.push.title')}</div>
      <div data-testid={`provider-push-state-${provider}`} style={{ color: 'var(--text-secondary)' }}>
        {stateLabel[state]}
        {activeCount > 0 && expiry ? ` · ${t('admin.integrations.push.expires', { when: new Date(expiry).toLocaleString() })}` : ''}
        {lastNotification ? ` · ${t('admin.integrations.push.lastEvent', { when: new Date(lastNotification).toLocaleString() })}` : ''}
      </div>
      {(state === 'needs_url' || state === 'disabled') && (
        <div style={{ color: 'var(--text-tertiary)' }}>{t('admin.integrations.push.pollingFallback')}</div>
      )}
      {reason && state !== 'active' && (
        <div style={{ color: 'var(--text-tertiary)' }}>{t('admin.integrations.push.reason', { reason })}</div>
      )}
      {renewalError && (
        <div data-testid={`provider-push-error-${provider}`} style={{ color: 'var(--red)' }}>
          {t('admin.integrations.push.renewalFailed', { code: renewalError })}
        </div>
      )}
      {provider === 'google' && (
        <div style={{ color: 'var(--text-tertiary)' }}>{t('admin.integrations.push.contactsPollingOnly')}</div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        {activeCount === 0 ? (
          <button
            data-testid={`provider-push-enable-${provider}`}
            disabled={busy || !local?.enabled || !local.webhookBaseUrl}
            onClick={() => toggle(true)}
            style={{ padding: '4px 10px', background: 'var(--accent)', border: 'none', borderRadius: 6, color: 'var(--accent-text)', fontSize: 12, cursor: busy ? 'not-allowed' : 'pointer' }}
          >
            {t('admin.integrations.push.enable')}
          </button>
        ) : (
          <button
            data-testid={`provider-push-disable-${provider}`}
            disabled={busy}
            onClick={() => toggle(false)}
            style={{ padding: '4px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-secondary)', fontSize: 12, cursor: busy ? 'not-allowed' : 'pointer' }}
          >
            {t('admin.integrations.push.disable')}
          </button>
        )}
      </div>
      {error && <div style={{ color: 'var(--red)' }}>{error}</div>}
    </div>
  );
}
